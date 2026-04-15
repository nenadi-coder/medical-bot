const { Telegraf } = require("telegraf");
const mysql = require("mysql2/promise");

// ===== ENV (we will set on Render later) =====
const BOT_TOKEN = process.env.BOT_TOKEN;

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// simple in-memory state (safe for small bot)
const userState = {};

const bot = new Telegraf(BOT_TOKEN);

// START
bot.start(async (ctx) => {
  userState[ctx.from.id] = "WAITING_EMAIL";
  ctx.reply("👋 Welcome\nPlease send your email to continue:");
});

// HANDLE MESSAGES
bot.on("text", async (ctx) => {
  const telegramId = ctx.from.id;
  const text = ctx.message.text;

  const state = userState[telegramId];

  // STEP 1: EMAIL LINKING
  if (state === "WAITING_EMAIL") {
    const [rows] = await db.query(
      "SELECT * FROM patients WHERE email = ?",
      [text]
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

    return ctx.reply(`✅ Welcome ${patient.first_name}`);
  }

  // STEP 2: MENU
  const [patientRows] = await db.query(
    "SELECT * FROM patients WHERE telegram_user_id = ?",
    [telegramId]
  );

  if (patientRows.length === 0) {
    userState[telegramId] = "WAITING_EMAIL";
    return ctx.reply("⚠️ Account not linked. Please send your email:");
  }

  const patient = patientRows[0];

  if (text === "My Appointments") {
    const [apps] = await db.query(
      "SELECT * FROM appointments WHERE patient_id = ?",
      [patient.patient_id]
    );

    if (!apps.length) return ctx.reply("No appointments found.");

    return ctx.reply(
      apps.map(a =>
        `📅 ${a.appointment_date} ${a.appointment_time} - ${a.status}`
      ).join("\n")
    );
  }

  ctx.reply(
    "📌 Menu:\n- My Appointments\n\n(Type option name)"
  );
});

bot.launch();
console.log("Bot running...");