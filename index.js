const express = require('express');
const { Telegraf } = require('telegraf');
const mysql = require('mysql2/promise');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

// ========== MYSQL DATABASE CONNECTION ==========
const dbConfig = {
    host: process.env.DB_HOST || 'sql207.infinityfree.com',
    user: process.env.DB_USER || 'if0_41555171',
    password: process.env.DB_PASSWORD || 'fkwDocFNbnScb0',
    database: process.env.DB_NAME || 'if0_41555171_medical_practice',
    waitForConnections: true,
    connectionLimit: 10
};

let pool;

async function initDB() {
    pool = mysql.createPool(dbConfig);
    console.log('✅ MySQL connected');
}

// ========== HELPER FUNCTIONS ==========

// Get or create user state (in memory for now - upgrade to DB table later)
const userStates = new Map();

function getUserState(telegramUserId) {
    if (!userStates.has(telegramUserId)) {
        userStates.set(telegramUserId, {
            telegram_user_id: telegramUserId,
            current_state: 'idle',
            linked_patient_id: null,
            pending_email: null
        });
    }
    return userStates.get(telegramUserId);
}

function updateUserState(telegramUserId, updates) {
    const state = getUserState(telegramUserId);
    Object.assign(state, updates);
    userStates.set(telegramUserId, state);
    return state;
}

// Get patient by telegram ID
async function getPatientByTelegramId(telegramUserId) {
    const [rows] = await pool.execute(
        'SELECT * FROM patients WHERE telegram_id = ?',
        [telegramUserId]
    );
    return rows[0] || null;
}

// Link patient to telegram
async function linkPatient(telegramUserId, email) {
    // Find patient by email
    const [patients] = await pool.execute(
        'SELECT * FROM patients WHERE email = ?',
        [email.toLowerCase()]
    );
    
    if (patients.length === 0) return null;
    const patient = patients[0];
    
    // Update patient with telegram_id
    await pool.execute(
        'UPDATE patients SET telegram_id = ? WHERE patient_id = ?',
        [telegramUserId, patient.patient_id]
    );
    
    // Update user state
    updateUserState(telegramUserId, {
        current_state: 'linked',
        linked_patient_id: patient.patient_id
    });
    
    return patient;
}

// Get upcoming appointments for patient
async function getUpcomingAppointments(patientId) {
    const [rows] = await pool.execute(
        `SELECT a.*, CONCAT(d.first_name, ' ', d.last_name) as doctor_name
         FROM appointments a
         LEFT JOIN doctors d ON a.doctor_id = d.doctor_id
         WHERE a.patient_id = ? 
         AND a.status = 'scheduled'
         AND a.appointment_date >= CURDATE()
         ORDER BY a.appointment_date ASC, a.appointment_time ASC`,
        [patientId]
    );
    return rows;
}

// Get queue position for an appointment
async function getQueuePosition(appointmentDate, appointmentTime) {
    const [rows] = await pool.execute(
        `SELECT COUNT(*) + 1 as position 
         FROM appointments 
         WHERE appointment_date = ? 
         AND appointment_time < ?
         AND status = 'scheduled'`,
        [appointmentDate, appointmentTime]
    );
    return rows[0]?.position || 1;
}

// Cancel appointment
async function cancelAppointment(appointmentId, patientId) {
    const [result] = await pool.execute(
        'UPDATE appointments SET status = ? WHERE appointment_id = ? AND patient_id = ?',
        ['cancelled', appointmentId, patientId]
    );
    return result.affectedRows > 0;
}

// Send message to Telegram
async function sendMessage(chatId, text, replyMarkup = null) {
    try {
        if (replyMarkup) {
            await bot.telegram.sendMessage(chatId, text, { 
                parse_mode: 'Markdown',
                reply_markup: replyMarkup
            });
        } else {
            await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('Send message error:', error);
    }
}

// Show main menu
async function showMainMenu(chatId, patient) {
    const keyboard = {
        keyboard: [
            ['📅 My Appointments', '🎫 Queue Position'],
            ['❌ Cancel Appointment', '📝 Reschedule Appointment'],
            ['❓ Help']
        ],
        resize_keyboard: true
    };
    
    await sendMessage(chatId, 
        `✅ Welcome back ${patient.first_name} ${patient.last_name}!\n\nWhat would you like to do?`,
        keyboard);
}

// ========== BOT COMMANDS ==========

// Start command
bot.start(async (ctx) => {
    const telegramUserId = ctx.from.id;
    const chatId = ctx.chat.id;
    
    getUserState(telegramUserId);
    const patient = await getPatientByTelegramId(telegramUserId);
    
    if (patient) {
        updateUserState(telegramUserId, { current_state: 'linked', linked_patient_id: patient.patient_id });
        await showMainMenu(chatId, patient);
    } else {
        updateUserState(telegramUserId, { current_state: 'awaiting_email' });
        await sendMessage(chatId, '👋 Welcome! Please send your email address to link your account.');
    }
});

// Handle text messages
bot.on('text', async (ctx) => {
    const telegramUserId = ctx.from.id;
    const chatId = ctx.chat.id;
    const text = ctx.message.text;
    
    const userState = getUserState(telegramUserId);
    const patient = await getPatientByTelegramId(telegramUserId);
    
    // If user is not linked and not awaiting email
    if (!patient && userState.current_state !== 'awaiting_email') {
        await sendMessage(chatId, '❌ Account not linked. Please send your email address to link your account.');
        updateUserState(telegramUserId, { current_state: 'awaiting_email' });
        return;
    }
    
    // Awaiting email for linking
    if (userState.current_state === 'awaiting_email' && !patient) {
        const email = text.trim().toLowerCase();
        const linkedPatient = await linkPatient(telegramUserId, email);
        
        if (linkedPatient) {
            await showMainMenu(chatId, linkedPatient);
        } else {
            await sendMessage(chatId, '❌ Email not found. Please register on our website first, or try again with a different email.');
        }
        return;
    }
    
    // Awaiting appointment ID for cancellation
    if (userState.current_state === 'awaiting_cancel') {
        const appointmentId = parseInt(text);
        if (isNaN(appointmentId)) {
            await sendMessage(chatId, '❌ Please send a valid appointment ID number.');
            return;
        }
        
        const success = await cancelAppointment(appointmentId, patient.patient_id);
        if (success) {
            await sendMessage(chatId, '✅ Appointment cancelled successfully.');
        } else {
            await sendMessage(chatId, '❌ Failed to cancel appointment. Please check the appointment ID and try again.');
        }
        
        updateUserState(telegramUserId, { current_state: 'linked' });
        await showMainMenu(chatId, patient);
        return;
    }
    
    // Handle menu options
    switch (text) {
        case '📅 My Appointments':
            const appointments = await getUpcomingAppointments(patient.patient_id);
            
            if (appointments.length === 0) {
                await sendMessage(chatId, '📭 You have no upcoming appointments.');
            } else {
                let messageText = '📅 *Your Upcoming Appointments:*\n\n';
                for (let i = 0; i < appointments.length; i++) {
                    const apt = appointments[i];
                    const date = new Date(apt.appointment_date).toLocaleDateString();
                    const queuePos = await getQueuePosition(apt.appointment_date, apt.appointment_time);
                    
                    messageText += `${i + 1}. 📍 *ID: ${apt.appointment_id}*\n`;
                    messageText += `   📅 Date: ${date}\n`;
                    messageText += `   ⏰ Time: ${apt.appointment_time}\n`;
                    messageText += `   👨‍⚕️ Doctor: ${apt.doctor_name}\n`;
                    messageText += `   🎫 Queue Position: #${queuePos}\n\n`;
                }
                messageText += 'To cancel, use: ❌ Cancel Appointment';
                await sendMessage(chatId, messageText);
            }
            break;
            
        case '🎫 Queue Position':
            const upcomingApps = await getUpcomingAppointments(patient.patient_id);
            
            if (upcomingApps.length === 0) {
                await sendMessage(chatId, '🎫 You have no upcoming appointments to check queue position.');
            } else {
                const nextApp = upcomingApps[0];
                const queuePos = await getQueuePosition(nextApp.appointment_date, nextApp.appointment_time);
                const date = new Date(nextApp.appointment_date).toLocaleDateString();
                
                await sendMessage(chatId, 
                    `🎫 *Your Queue Position*\n\n📅 Date: ${date}\n⏰ Time: ${nextApp.appointment_time}\n🎫 Your position: #${queuePos}\n\n👥 People ahead of you: ${queuePos - 1}`);
            }
            break;
            
        case '❌ Cancel Appointment':
            const activeApps = await getUpcomingAppointments(patient.patient_id);
            
            if (activeApps.length === 0) {
                await sendMessage(chatId, '❌ You have no upcoming appointments to cancel.');
            } else {
                let messageText = '📋 *Your appointments:*\n\n';
                for (const apt of activeApps) {
                    const date = new Date(apt.appointment_date).toLocaleDateString();
                    messageText += `🆔 ID: ${apt.appointment_id} - ${date} at ${apt.appointment_time}\n`;
                }
                messageText += '\n✏️ Please send the **appointment ID** you want to cancel.';
                await sendMessage(chatId, messageText);
                updateUserState(telegramUserId, { current_state: 'awaiting_cancel' });
            }
            break;
            
        case '📝 Reschedule Appointment':
            await sendMessage(chatId, 
                '📝 *Reschedule Feature*\n\nPlease contact the clinic directly to reschedule your appointment.\n\nAlternatively, you can cancel and book a new appointment.');
            break;
            
        case '❓ Help':
            await sendMessage(chatId,
                `📖 *Help Menu*\n\n` +
                `🔹 *Send email* - Link your account\n` +
                `🔹 *📅 My Appointments* - View all upcoming appointments\n` +
                `🔹 *🎫 Queue Position* - Check your current queue position\n` +
                `🔹 *❌ Cancel Appointment* - Cancel an existing appointment\n` +
                `🔹 *📝 Reschedule Appointment* - Instructions to reschedule\n` +
                `🔹 *❓ Help* - Show this menu`);
            break;
            
        default:
            await sendMessage(chatId, '❓ Unknown command. Please use the menu buttons or type /start to reset.');
    }
});

// ========== EXPRESS WEBHOOK SETUP ==========

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Webhook endpoint for Telegram
app.use(bot.webhookCallback('/webhook'));

// Set webhook URL
const RENDER_URL = process.env.RENDER_URL || 'https://your-bot.onrender.com';

// Start the server
async function start() {
    await initDB();
    
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`Bot webhook listening on port ${port}`);
    });
    
    // Set webhook
    try {
        await bot.telegram.setWebhook(`${RENDER_URL}/webhook`);
        console.log('Webhook set successfully');
    } catch (err) {
        console.error('Failed to set webhook:', err);
    }
}

start().catch(console.error);
