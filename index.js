// Cloudflare Worker Telegram Bot - Clinic Appointment System
// Connects to InfinityFree MySQL database via API

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        
        // Handle webhook endpoint
        if (url.pathname === '/webhook' && request.method === 'POST') {
            const update = await request.json();
            env.ctx.waitUntil(handleUpdate(update, env));
            return new Response('OK', { status: 200 });
        }
        
        // Health check
        if (url.pathname === '/health') {
            return new Response('OK', { status: 200 });
        }
        
        return new Response('Bot is running', { status: 200 });
    }
};

// ========== DATABASE CONNECTION via InfinityFree API ==========
async function queryDatabase(sql, params, env) {
    // Since Cloudflare can't directly connect to InfinityFree MySQL,
    // we call a PHP API on your InfinityFree site
    const response = await fetch(`https://${env.DB_HOST}/api.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sql: sql,
            params: params,
            key: env.API_SECRET
        })
    });
    
    const result = await response.json();
    return result;
}

// Get patient by Telegram ID
async function getPatientByTelegramId(telegramUserId, env) {
    const result = await queryDatabase(
        'SELECT * FROM patients WHERE telegram_id = ?',
        [telegramUserId], env
    );
    return result.length > 0 ? result[0] : null;
}

// Get patient by email
async function getPatientByEmail(email, env) {
    const result = await queryDatabase(
        'SELECT * FROM patients WHERE email = ?',
        [email.toLowerCase()], env
    );
    return result.length > 0 ? result[0] : null;
}

// Link patient to Telegram ID
async function linkPatient(telegramUserId, patientId, env) {
    await queryDatabase(
        'UPDATE patients SET telegram_id = ? WHERE patient_id = ?',
        [telegramUserId, patientId], env
    );
}

// Get upcoming appointments for patient
async function getUpcomingAppointments(patientId, env) {
    const result = await queryDatabase(
        `SELECT a.*, 
                CONCAT(d.first_name, ' ', d.last_name) as doctor_name
         FROM appointments a
         LEFT JOIN doctors d ON a.doctor_id = d.doctor_id
         WHERE a.patient_id = ? 
         AND a.status = 'scheduled'
         AND a.appointment_date >= CURDATE()
         ORDER BY a.appointment_date ASC, a.appointment_time ASC`,
        [patientId], env
    );
    return result;
}

// Get queue position for an appointment
async function getQueuePosition(appointmentDate, appointmentTime, env) {
    const result = await queryDatabase(
        `SELECT COUNT(*) + 1 as position 
         FROM appointments 
         WHERE appointment_date = ? 
         AND appointment_time < ?
         AND status = 'scheduled'`,
        [appointmentDate, appointmentTime], env
    );
    return result[0]?.position || 1;
}

// Cancel appointment
async function cancelAppointment(appointmentId, patientId, env) {
    const result = await queryDatabase(
        'UPDATE appointments SET status = ? WHERE appointment_id = ? AND patient_id = ?',
        ['cancelled', appointmentId, patientId], env
    );
    return result.affectedRows > 0;
}

// ========== TELEGRAM FUNCTIONS ==========

async function sendMessage(chatId, text, env, keyboard = null) {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
    const body = {
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown'
    };
    
    if (keyboard) {
        body.reply_markup = JSON.stringify(keyboard);
    }
    
    await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

async function showMainMenu(chatId, patient, env) {
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
        env, keyboard);
}

// ========== USER STATE MANAGEMENT (KV Storage) ==========

async function getUserState(userId, env) {
    const key = `state:${userId}`;
    let state = await env.USER_STATES.get(key, { type: 'json' });
    if (!state) {
        state = {
            userId: userId,
            state: 'idle',
            patientId: null,
            pendingCancelId: null
        };
        await env.USER_STATES.put(key, JSON.stringify(state));
    }
    return state;
}

async function updateUserState(userId, updates, env) {
    const key = `state:${userId}`;
    let state = await getUserState(userId, env);
    state = { ...state, ...updates };
    await env.USER_STATES.put(key, JSON.stringify(state));
    return state;
}

// ========== HANDLE MESSAGES ==========

async function handleUpdate(update, env) {
    try {
        if (update.message) {
            await handleMessage(update.message, env);
        }
    } catch (error) {
        console.error('Error handling update:', error);
    }
}

async function handleMessage(message, env) {
    const userId = message.from.id;
    const chatId = message.chat.id;
    const text = message.text || '';
    
    const userState = await getUserState(userId, env);
    const patient = await getPatientByTelegramId(userId, env);
    
    // Handle /start command
    if (text === '/start') {
        if (patient) {
            await updateUserState(userId, { state: 'linked', patientId: patient.patient_id }, env);
            await showMainMenu(chatId, patient, env);
        } else {
            await updateUserState(userId, { state: 'awaiting_email' }, env);
            await sendMessage(chatId, '👋 Welcome! Please send your email address to link your account.', env);
        }
        return;
    }
    
    // Handle email linking (user not yet linked)
    if (!patient && userState.state === 'awaiting_email') {
        const email = text.toLowerCase().trim();
        const foundPatient = await getPatientByEmail(email, env);
        
        if (foundPatient) {
            await linkPatient(userId, foundPatient.patient_id, env);
            await updateUserState(userId, { 
                state: 'linked', 
                patientId: foundPatient.patient_id 
            }, env);
            await showMainMenu(chatId, foundPatient, env);
        } else {
            await sendMessage(chatId, '❌ Email not found. Please register on our website first, or try again with a different email.', env);
        }
        return;
    }
    
    // If not linked, ask for email
    if (!patient) {
        await sendMessage(chatId, '❌ Account not linked. Please send your email address to link your account.', env);
        await updateUserState(userId, { state: 'awaiting_email' }, env);
        return;
    }
    
    // Handle cancel appointment - waiting for appointment ID
    if (userState.state === 'awaiting_cancel_id') {
        const appointmentId = parseInt(text);
        if (!isNaN(appointmentId)) {
            const success = await cancelAppointment(appointmentId, patient.patient_id, env);
            if (success) {
                await sendMessage(chatId, `✅ Appointment #${appointmentId} has been cancelled.`, env);
            } else {
                await sendMessage(chatId, `❌ Failed to cancel appointment #${appointmentId}. Please check the ID and try again.`, env);
            }
            await updateUserState(userId, { state: 'linked' }, env);
            await showMainMenu(chatId, patient, env);
        } else {
            await sendMessage(chatId, '❌ Please send a valid appointment ID number.', env);
        }
        return;
    }
    
    // Handle menu options (linked user)
    switch (text) {
        case '📅 My Appointments':
            const appointments = await getUpcomingAppointments(patient.patient_id, env);
            
            if (appointments.length === 0) {
                await sendMessage(chatId, '📭 You have no upcoming appointments.', env);
            } else {
                let messageText = '📅 *Your Upcoming Appointments:*\n\n';
                for (let i = 0; i < appointments.length; i++) {
                    const apt = appointments[i];
                    const date = new Date(apt.appointment_date).toLocaleDateString();
                    const queuePos = await getQueuePosition(apt.appointment_date, apt.appointment_time, env);
                    
                    messageText += `${i + 1}. 📍 *ID: ${apt.appointment_id}*\n`;
                    messageText += `   📅 Date: ${date}\n`;
                    messageText += `   ⏰ Time: ${apt.appointment_time}\n`;
                    messageText += `   👨‍⚕️ Doctor: ${apt.doctor_name}\n`;
                    messageText += `   🎫 Queue Position: #${queuePos}\n\n`;
                }
                messageText += 'To cancel, use: ❌ Cancel Appointment';
                await sendMessage(chatId, messageText, env);
            }
            break;
            
        case '🎫 Queue Position':
            const upcomingApps = await getUpcomingAppointments(patient.patient_id, env);
            
            if (upcomingApps.length === 0) {
                await sendMessage(chatId, '🎫 You have no upcoming appointments to check queue position.', env);
            } else {
                const nextApp = upcomingApps[0];
                const queuePos = await getQueuePosition(nextApp.appointment_date, nextApp.appointment_time, env);
                const date = new Date(nextApp.appointment_date).toLocaleDateString();
                
                await sendMessage(chatId, 
                    `🎫 *Your Queue Position*\n\n📅 Date: ${date}\n⏰ Time: ${nextApp.appointment_time}\n🎫 Your position: #${queuePos}\n\n👥 People ahead of you: ${queuePos - 1}`,
                    env);
            }
            break;
            
        case '❌ Cancel Appointment':
            const activeApps = await getUpcomingAppointments(patient.patient_id, env);
            
            if (activeApps.length === 0) {
                await sendMessage(chatId, '❌ You have no upcoming appointments to cancel.', env);
            } else {
                let messageText = '📋 *Your appointments:*\n\n';
                for (const apt of activeApps) {
                    const date = new Date(apt.appointment_date).toLocaleDateString();
                    messageText += `🆔 ID: ${apt.appointment_id} - ${date} at ${apt.appointment_time}\n`;
                }
                messageText += '\n✏️ Please send the **appointment ID** you want to cancel.';
                await sendMessage(chatId, messageText, env);
                await updateUserState(userId, { state: 'awaiting_cancel_id' }, env);
            }
            break;
            
        case '📝 Reschedule Appointment':
            await sendMessage(chatId, 
                '📝 *Reschedule Feature*\n\nPlease contact the clinic directly to reschedule your appointment.\n\nAlternatively, you can cancel and book a new appointment.',
                env);
            break;
            
        case '❓ Help':
            await sendMessage(chatId,
                `📖 *Help Menu*\n\n` +
                `• Send your email - Link your account\n` +
                `• 📅 My Appointments - View your appointments\n` +
                `• 🎫 Queue Position - Check your queue position\n` +
                `• ❌ Cancel Appointment - Cancel an appointment\n` +
                `• 📝 Reschedule Appointment - Reschedule info\n` +
                `• /start - Restart the bot`,
                env);
            break;
            
        default:
            await sendMessage(chatId, '❓ Unknown command. Please use the menu buttons or type /start.', env);
    }
}
