const { Telegraf, Markup } = require("telegraf");
const mysql = require("mysql2/promise");

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;

// ================= DB =================
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// ================= SIMPLE STATE =================
const state = {}; // WAITING_EMAIL, MENU, WAITING_RESCHEDULE

// ================= BOT =================
const bot = new Telegraf(BOT_TOKEN);

// ---------------- START ----------------
bot.start(async (ctx) => {
  const id = ctx.from.id;
  state[id] = "WAITING_EMAIL";

  ctx.reply("👋 Welcome\nPlease send your email to link your account:");
});

// ---------------- MESSAGE HANDLER ----------------
bot.on("text", async (ctx) => {
  const id = ctx.from.id;
  const text = ctx.message.text.trim();

  // ========== STEP 1: EMAIL LINKING ==========
  if (state[id] === "WAITING_EMAIL") {
    const email = text.toLowerCase();

    const [rows] = await db.query(
      "SELECT * FROM patients WHERE LOWER(email) = ?",
      [email]
    );

    if (!rows.length) {
      return ctx.reply("❌ Email not found. Please register on website first.");
    }

    const patient = rows[0];

    await db.query(
      "UPDATE patients SET telegram_user_id = ? WHERE patient_id = ?",
      [id, patient.patient_id]
    );

    state[id] = "MENU";

    return ctx.reply(
      `✅ Welcome ${patient.first_name}`,
      Markup.keyboard([
        ["📅 My Appointments"],
        ["❌ Cancel Appointment", "🔁 Reschedule Appointment"],
      ]).resize()
    );
  }

  // ========== STEP 2: GET PATIENT ==========
  const [pRows] = await db.query(
    "SELECT * FROM patients WHERE telegram_user_id = ?",
    [id]
  );

  if (!pRows.length) {
    state[id] = "WAITING_EMAIL";
    return ctx.reply("⚠️ Account not linked. Please send your email:");
  }

  const patient = pRows[0];

  // ========== MY APPOINTMENTS ==========
  if (text === "📅 My Appointments") {
    const [apps] = await db.query(
      "SELECT * FROM appointments WHERE patient_id = ?",
      [patient.patient_id]
    );

    if (!apps.length) return ctx.reply("No appointments found.");

    return ctx.reply(
      apps
        .map(
          (a) =>
            `ID: ${a.appointment_id}\n📅 ${a.appointment_date} ${a.appointment_time}\nStatus: ${a.status}`
        )
        .join("\n\n")
    );
  }

  // ========== CANCEL ==========
  if (text === "❌ Cancel Appointment") {
    return ctx.reply("Send: Cancel <appointment_id>");
  }

  if (text.startsWith("Cancel")) {
    const idToCancel = text.split(" ")[1];

    await db.query(
      "UPDATE appointments SET status = 'cancelled' WHERE appointment_id = ?",
      [idToCancel]
    );

    return ctx.reply("❌ Appointment cancelled.");
  }

  // ========== RESCHEDULE ==========
  if (text === "🔁 Reschedule Appointment") {
    return ctx.reply(
      "Send:\nReschedule <id> <YYYY-MM-DD> <HH:MM>\nExample:\nReschedule 3 2026-05-10 14:00"
    );
  }

  if (text.startsWith("Reschedule")) {
    const parts = text.split(" ");

    const appId = parts[1];
    const newDate = parts[2];
    const newTime = parts[3];

    await db.query(
      "UPDATE appointments SET appointment_date = ?, appointment_time = ? WHERE appointment_id = ?",
      [newDate, newTime, appId]
    );

    return ctx.reply("🔁 Appointment rescheduled.");
  }

  ctx.reply("Use menu buttons below 👇");
});

// ================= START BOT =================
bot.launch();
console.log("Bot running...");
