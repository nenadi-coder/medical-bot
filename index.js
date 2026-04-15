const { Telegraf } = require("telegraf");
const mysql = require("mysql2/promise");

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  throw new Error("❌ BOT_TOKEN is missing in environment variables");
}

// ================= DB =================
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// ================= STATE =================
const userState = {};

// ================= BOT =================
const bot = new Telegraf(BOT_TOKEN);

// ================= START =================
bot.start(async (ctx) => {
  const telegramId = ctx.from.id;

  userState[telegramId] = "WAITING_EMAIL";

  return ctx.reply(
    "👋 Welcome\n\n📩 Please send your email to continue:"
  );
});

// ================= MAIN HANDLER =================
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text.trim();

  try {
    const state = userState[telegramId];

    // ================= STEP 1: EMAIL LINKING =================
    if (state === "WAITING_EMAIL") {
      const email = text.toLowerCase();

      const [rows] = await db.query(
        "SELECT * FROM patients WHERE LOWER(email) = ?",
        [email]
      );

      if (rows.length === 0) {
        return ctx.reply("❌ Email not found. Try again:");
      }

      const patient = rows[0];

      await db.query(
        "UPDATE patients SET telegram_user_id = ? WHERE patient_id = ?",
        [telegramId, patient.patient_id]
      );

      userState[telegramId] = "LINKED";

      return ctx.reply(
        `✅ Welcome ${patient.first_name}\n\nType: My Appointments`
      );
    }

    // ================= STEP 2: CHECK LINK =================
    const [patientRows] = await db.query(
      "SELECT * FROM patients WHERE telegram_user_id = ?",
      [telegramId]
    );

    if (patientRows.length === 0) {
      userState[telegramId] = "WAITING_EMAIL";
      return ctx.reply("⚠️ Account not linked. Please send your email:");
    }

    const patient = patientRows[0];

    // ================= STEP 3: MENU =================
    if (text === "My Appointments") {
      const [apps] = await db.query(
        "SELECT * FROM appointments WHERE patient_id = ? ORDER BY appointment_date DESC",
        [patient.patient_id]
      );

      if (apps.length === 0) {
        return ctx.reply("📭 No appointments found.");
      }

      const message = apps
        .map(
          (a) =>
            `🆔 ${a.appointment_id}\n📅 ${a.appointment_date} ${a.appointment_time}\n📌 ${a.status}`
        )
        .join("\n\n");

      return ctx.reply(message);
    }

    // ================= DEFAULT =================
    return ctx.reply(
      "📌 Menu:\n- My Appointments\n\n👉 Type: My Appointments"
    );
  } catch (err) {
    console.error("BOT ERROR:", err);
    return ctx.reply("⚠️ Server error. Try again later.");
  }
});

// ================= START BOT =================
bot.launch();
console.log("🤖 Bot running...");
