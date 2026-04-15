// Cloudflare Worker Telegram Bot - Clinic Appointment System (DYNAMIC)
// Uses KV for user state and connects to your MySQL database via API

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
    try {
        // Call your PHP API on InfinityFree
        const response = await fetch(`https://${env.DB_HOST}/bot_api.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sql: sql,
                params: params,
                secret: env.API_SECRET
            })
        });
        
        const result = await response.json();
        return result;
    } catch (error) {
        console.error('Database error:', error);
        return { error: error.message };
    }
}

// Get patient by Telegram ID
async function getPatientByTelegramId(telegramUserId, env) {
    const result = await queryDatabase(
        'SELECT patient_id, first_name, last_name, email, phone FROM patients WHERE telegram_id = ?',
        [telegramUserId.toString()], env
    );
    return result && result.length > 0 ? result[0] : null;
}

// Get patient by email
async function getPatientByEmail(email, env) {
    const result = await queryDatabase(
        'SELECT patient_id, first_name, last_name, email, phone FROM patients WHERE email = ?',
        [email.toLowerCase()], env
    );
    return result && result.length > 0 ? result[0] : null;
}

// Link patient to Telegram ID
async function linkPatient(telegramUserId, patientId, env) {
    await queryDatabase(
        'UPDATE patients SET telegram_id = ? WHERE patient_id = ?',
        [telegramUserId.toString(), patientId], env
    );
}

// Get upcoming appointments for patient
async function getUpcomingAppointments(patientId, env) {
    const result = await queryDatabase(
        `SELECT a.appointment_id, a.appointment_date, a.appointment_time, a.queue_number, a.status,
                CONCAT(d.first_name, ' ', d.last_name) as doctor_name
         FROM appointments a
         LEFT JOIN doctors d ON a.doctor_id = d.doctor_id
         WHERE a.patient_id = ? 
         AND a.status IN ('scheduled', 'confirmed')
         AND a.appointment_date >= CURDATE()
         ORDER BY a.appointment_date ASC, a.appointment_time ASC
         LIMIT 10`,
        [patientId], env
    );
    return result && result.length > 0 ? result : [];
}

// Get queue position for an appointment
async function getQueuePosition(appointmentDate, appointmentTime, env) {
    const result = await queryDatabase(
        `SELECT COUNT(*) + 1 as position 
         FROM appointments 
         WHERE appointment_date = ? 
         AND appointment_time < ?
         AND status IN ('scheduled', 'confirmed')`,
        [appointmentDate, appointmentTime], env
    );
    return result && result.length > 0 ? result[0].position : 1;
}

// Get total people waiting for a specific date
async function getTotalWaitingForDate(appointmentDate, env) {
    const result = await queryDatabase(
        `SELECT COUNT(*) as total 
         FROM appointments 
         WHERE appointment_date = ? 
         AND status IN ('scheduled', 'confirmed')`,
        [appointmentDate], env
    );
    return result && result.length > 0 ? result[0].total : 0;
}

// Cancel appointment
async function cancelAppointment(appointmentId, patientId, env) {
    const result = await queryDatabase(
        'UPDATE appointments SET status = ? WHERE appointment_id = ? AND patient_id = ?',
        ['cancelled', appointmentId, patientId], env
    );
    return result && !result.error;
}

// ========== USER STATE FUNCTIONS (KV) ==========

async function getUserState(userId, env) {
    const key = `state:${userId}`;
    let state = await env.USER_STATES.get(key, { type: 'json' });
    if (!state) {
        state = {
            userId: userId,
            state: 'idle',
            patientId: null,
            patientName: null,
            patientEmail: null,
            waitingForCancelId: null
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
    
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return response;
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
        `✅ Welcome back *${patient.first_name} ${patient.last_name}*!\n\nWhat would you like to do?`,
        env, keyboard);
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
    
    let userState = await getUserState(userId, env);
    let patient = null;
    
    // Try to get patient from database using stored patientId
    if (userState.patientId) {
        patient = await getPatientByTelegramId(userId, env);
        if (patient) {
            userState.patientName = patient.first_name;
            userState.patientEmail = patient.email;
            await updateUserState(userId, { patientId: patient.patient_id }, env);
        }
    }
    
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
    
    // Handle email linking
    if (userState.state === 'awaiting_email' && !patient) {
        const email = text.toLowerCase().trim();
        if (email.includes('@') && email.includes('.')) {
            const foundPatient = await getPatientByEmail(email, env);
            
            if (foundPatient) {
                await linkPatient(userId, foundPatient.patient_id, env);
                await updateUserState(userId, { 
                    state: 'linked', 
                    patientId: foundPatient.patient_id,
                    patientName: foundPatient.first_name,
                    patientEmail: foundPatient.email
                }, env);
                await showMainMenu(chatId, foundPatient, env);
            } else {
                await sendMessage(chatId, '❌ Email not found. Please register on our website first, or try again with a different email.', env);
            }
        } else {
            await sendMessage(chatId, '❌ Please send a valid email address (e.g., name@example.com).', env);
        }
        return;
    }
    
    // Handle cancel appointment - waiting for ID
    if (userState.state === 'awaiting_cancel') {
        const appointmentId = parseInt(text);
        if (!isNaN(appointmentId)) {
            const success = await cancelAppointment(appointmentId, userState.patientId, env);
            if (success) {
                await sendMessage(chatId, `✅ Appointment #${appointmentId} has been cancelled successfully.`, env);
            } else {
                await sendMessage(chatId, `❌ Failed to cancel appointment #${appointmentId}. Please check the ID and try again.`, env);
            }
            await updateUserState(userId, { state: 'linked', waitingForCancelId: null }, env);
            const updatedPatient = await getPatientByTelegramId(userId, env);
            if (updatedPatient) {
                await showMainMenu(chatId, updatedPatient, env);
            }
        } else {
            await sendMessage(chatId, '❌ Please send a valid appointment ID number.', env);
        }
        return;
    }
    
    // If not linked, ask for email
    if (!patient) {
        await sendMessage(chatId, '❌ Account not linked. Please send your email address to link your account.', env);
        await updateUserState(userId, { state: 'awaiting_email' }, env);
        return;
    }
    
    // Handle menu options (linked user)
    switch (text) {
        case '📅 My Appointments':
            const appointments = await getUpcomingAppointments(patient.patient_id, env);
            
            if (appointments.length === 0) {
                await sendMessage(chatId, '📭 You have no upcoming appointments.\n\nTo book an appointment, please visit our website or call the clinic.', env);
            } else {
                let messageText = '📅 *Your Upcoming Appointments:*\n\n';
                for (let i = 0; i < appointments.length; i++) {
                    const apt = appointments[i];
                    const date = new Date(apt.appointment_date).toLocaleDateString('en-US', { 
                        weekday: 'short', 
                        month: 'short', 
                        day: 'numeric' 
                    });
                    const time = apt.appointment_time.substring(0, 5);
                    const queuePos = apt.queue_number || await getQueuePosition(apt.appointment_date, apt.appointment_time, env);
                    
                    messageText += `${i + 1}. 📍 *ID: ${apt.appointment_id}*\n`;
                    messageText += `   📅 Date: ${date}\n`;
                    messageText += `   ⏰ Time: ${time}\n`;
                    messageText += `   👨‍⚕️ Doctor: ${apt.doctor_name || 'General'}\n`;
                    messageText += `   🎫 Queue Position: #${queuePos}\n`;
                    messageText += `   📊 Status: ${apt.status === 'confirmed' ? '✅ Confirmed' : '⏳ Pending'}\n\n`;
                }
                messageText += 'To cancel, use: ❌ Cancel Appointment';
                await sendMessage(chatId, messageText, env);
            }
            break;
            
        case '🎫 Queue Position':
            const upcomingApps = await getUpcomingAppointments(patient.patient_id, env);
            
            if (upcomingApps.length === 0) {
                await sendMessage(chatId, '🎫 You have no upcoming appointments to check queue position.\n\nBook an appointment first!', env);
            } else {
                const nextApp = upcomingApps[0];
                const queuePos = nextApp.queue_number || await getQueuePosition(nextApp.appointment_date, nextApp.appointment_time, env);
                const totalWaiting = await getTotalWaitingForDate(nextApp.appointment_date, env);
                const date = new Date(nextApp.appointment_date).toLocaleDateString('en-US', { 
                    weekday: 'short', 
                    month: 'short', 
                    day: 'numeric' 
                });
                const time = nextApp.appointment_time.substring(0, 5);
                
                let messageText = `🎫 *Your Queue Position*\n\n`;
                messageText += `📅 Date: ${date}\n`;
                messageText += `⏰ Time: ${time}\n`;
                messageText += `👨‍⚕️ Doctor: ${nextApp.doctor_name || 'General'}\n`;
                messageText += `━━━━━━━━━━━━━━━\n`;
                messageText += `🎫 *Your position: #${queuePos}*\n`;
                messageText += `👥 Total waiting: ${totalWaiting} patients\n`;
                messageText += `📊 People ahead of you: ${queuePos - 1}\n`;
                
                if (queuePos === 1) {
                    messageText += `\n✅ *You're NEXT!* Please be ready when called.`;
                } else if (queuePos <= 3) {
                    messageText += `\n⏰ *You'll be seen soon!* Please stay nearby.`;
                } else {
                    const estimatedMinutes = (queuePos - 1) * 15;
                    messageText += `\n⏱️ Estimated wait: ~${estimatedMinutes} minutes`;
                }
                
                await sendMessage(chatId, messageText, env);
            }
            break;
            
        case '❌ Cancel Appointment':
            const activeApps = await getUpcomingAppointments(patient.patient_id, env);
            
            if (activeApps.length === 0) {
                await sendMessage(chatId, '❌ You have no upcoming appointments to cancel.', env);
            } else {
                let messageText = '📋 *Your appointments:*\n\n';
                for (const apt of activeApps) {
                    const date = new Date(apt.appointment_date).toLocaleDateString('en-US', { 
                        month: 'short', 
                        day: 'numeric' 
                    });
                    messageText += `🆔 *ID: ${apt.appointment_id}* - ${date} at ${apt.appointment_time.substring(0, 5)} with ${apt.doctor_name || 'General'}\n`;
                }
                messageText += '\n✏️ Please send the **appointment ID** number you want to cancel.';
                await sendMessage(chatId, messageText, env);
                await updateUserState(userId, { state: 'awaiting_cancel' }, env);
            }
            break;
            
        case '📝 Reschedule Appointment':
            await sendMessage(chatId, 
                '📝 *Reschedule Feature*\n\n' +
                'To reschedule your appointment, please:\n\n' +
                '1️⃣ Cancel your current appointment using ❌ Cancel Appointment\n' +
                '2️⃣ Book a new appointment on our website\n\n' +
                '📞 Or call us directly: +213 XXX XX XX XX\n\n' +
                '💡 *Tip:* You can cancel and rebook anytime through this bot!', env);
            break;
            
        case '❓ Help':
            await sendMessage(chatId,
                '📖 *Help Menu*\n\n' +
                '┌─ ── ── ── ── ── ── ──\n' +
                '│ 🔹 *Send email* - Link your account\n' +
                '│ 🔹 *📅 My Appointments* - View appointments\n' +
                '│ 🔹 *🎫 Queue Position* - Check queue position\n' +
                '│ 🔹 *❌ Cancel Appointment* - Cancel an appointment\n' +
                '│ 🔹 *📝 Reschedule Appointment* - Reschedule info\n' +
                '│ 🔹 *❓ Help* - Show this menu\n' +
                '│ 🔹 */start* - Restart the bot\n' +
                '└─ ── ── ── ── ── ── ──\n\n' +
                '📞 *Need help?* Contact the clinic at +213 XXX XX XX XX', env);
            break;
            
        default:
            await sendMessage(chatId, 
                '❓ *Unknown command*\n\n' +
                'Please use the menu buttons below or type /start to reset.\n\n' +
                'Available commands:\n' +
                '• 📅 My Appointments\n' +
                '• 🎫 Queue Position\n' +
                '• ❌ Cancel Appointment\n' +
                '• 📝 Reschedule Appointment\n' +
                '• ❓ Help', env);
    }
}
