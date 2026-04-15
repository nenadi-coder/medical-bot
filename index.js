const { Telegraf, Markup } = require("telegraf");
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

// ================= BOT STATE =================
const state = {}; 
// structure:
// state[userId] = "WAITING_EMAIL"

// ================= BOT =================
const bot = new Telegraf(BOT_TOKEN);

// ================= START =================
bot.start(async (ctx) => {
  const id = ctx.from.id;

  state[id] = "WAITING_EMAIL";

  await ctx.reply(
    "👋 Welcome to Medical Bot\n\n📩 Please send your email to link your account:"
  );
});

// ================= MAIN HANDLER =================
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text.trim();

  try {
    // ================= 1. EMAIL LINKING =================
    if (state[telegramId] === "WAITING_EMAIL") {
      const email = text.toLowerCase().replace(/\s+/g, "");

      const [rows] = await db.query(
        "SELECT * FROM patients WHERE LOWER(email) = ?",
        [email]
      );

      if (!rows.length) {
        return ctx.reply("❌ Email not found. Please register on the website first.");
      }

      const patient = rows[0];

      await db.query(
        "UPDATE patients SET telegram_user_id = ? WHERE patient_id = ?",
        [telegramId, patient.patient_id]
      );

      state[telegramId] = "MENU";

      return ctx.reply(
        `✅ Welcome ${patient.first_name}`,
        Markup.keyboard([
          ["📅 My Appointments"],
          ["❌ Cancel Appointment", "🔁 Reschedule Appointment"],
        ]).resize()
      );
    }

    // ================= 2. GET LINKED PATIENT =================
    const [pRows] = await db.query(
      "SELECT * FROM patients WHERE telegram_user_id = ?",
      [telegramId]
    );

    if (!pRows.length) {
      state[telegramId] = "WAITING_EMAIL";
      return ctx.reply("⚠️ Account not linked. Please send your email:");
    }

    const patient = pRows[0];

    // ================= 3. MY APPOINTMENTS =================
    if (text === "📅 My Appointments") {
      const [apps] = await db.query(
        "SELECT * FROM appointments WHERE patient_id = ? ORDER BY appointment_date DESC",
        [patient.patient_id]
      );

      if (!apps.length) {
        return ctx.reply("📭 No appointments found.");
      }

      const message = apps
        .map(
          (a) =>
            `🆔 ID: ${a.appointment_id}\n📅 ${a.appointment_date} ${a.appointment_time}\n📌 Status: ${a.status}`
        )
        .join("\n\n");

      return ctx.reply(message);
    }

    // ================= 4. CANCEL =================
    if (text === "❌ Cancel Appointment") {
      return ctx.reply("Send:\n❌ Cancel <appointment_id>");
    }

    if (text.startsWith("Cancel")) {
      const parts = text.split(" ");
      const appointmentId = parts[1];

      if (!appointmentId) {
        return ctx.reply("❌ Invalid format. Example: Cancel 5");
      }

      await db.query(
        "UPDATE appointments SET status = 'cancelled' WHERE appointment_id = ? AND patient_id = ?",
        [appointmentId, patient.patient_id]
      );

      return ctx.reply("❌ Appointment cancelled successfully.");
    }

    // ================= 5. RESCHEDULE =================
    if (text === "🔁 Reschedule Appointment") {
      return ctx.reply(
        "Send:\n🔁 Reschedule <id> <YYYY-MM-DD> <HH:MM>\n\nExample:\nReschedule 3 2026-05-10 14:00"
      );
    }

    if (text.startsWith("Reschedule")) {
      const parts = text.split(" ");

      const appointmentId = parts[1];
      const newDate = parts[2];
      const newTime = parts[3];

      if (!appointmentId || !newDate || !newTime) {
        return ctx.reply("❌ Invalid format.\nExample: Reschedule 3 2026-05-10 14:00");
      }

      await db.query(
        "UPDATE appointments SET appointment_date = ?, appointment_time = ? WHERE appointment_id = ? AND patient_id = ?",
        [newDate, newTime, appointmentId, patient.patient_id]
      );

      return ctx.reply("🔁 Appointment rescheduled successfully.");
    }

    // ================= DEFAULT =================
    return ctx.reply("Use the menu buttons below 👇");
  } catch (err) {
    console.error("BOT ERROR:", err);
    return ctx.reply("⚠️ Server error. Please try again later.");
  }
});

// ================= START =================
bot.launch();
console.log("🤖 Bot running...");
