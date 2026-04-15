const express = require('express');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

// Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Health check endpoint (REQUIRED for Render)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Webhook endpoint for Telegram
app.use(await bot.createWebhook({ domain: process.env.RENDER_URL }));

// ========== HELPER FUNCTIONS ==========

// Get or create user state
async function getUserState(telegramUserId) {
    const { data, error } = await supabase
        .from('telegram_user_states')
        .select('*')
        .eq('telegram_user_id', telegramUserId)
        .maybeSingle();
    
    if (error || !data) {
        // Create new state
        const { data: newState, error: createError } = await supabase
            .from('telegram_user_states')
            .insert({
                telegram_user_id: telegramUserId,
                current_state: 'idle',
                chat_id: telegramUserId
            })
            .select()
            .single();
        
        if (createError) return null;
        return newState;
    }
    return data;
}

// Update user state
async function updateUserState(telegramUserId, updates) {
    const { data, error } = await supabase
        .from('telegram_user_states')
        .update(updates)
        .eq('telegram_user_id', telegramUserId)
        .select()
        .single();
    
    if (error) return null;
    return data;
}

// Get patient by telegram ID
async function getPatientByTelegramId(telegramUserId) {
    const { data, error } = await supabase
        .from('patients')
        .select('*')
        .eq('telegram_id', telegramUserId)
        .maybeSingle();
    
    if (error || !data) return null;
    return data;
}

// Link patient to telegram
async function linkPatient(telegramUserId, email) {
    // Find patient by email
    const { data: patient, error: findError } = await supabase
        .from('patients')
        .select('*')
        .eq('email', email.toLowerCase())
        .maybeSingle();
    
    if (findError || !patient) return null;
    
    // Update patient with telegram_id
    const { error: updateError } = await supabase
        .from('patients')
        .update({ telegram_id: telegramUserId })
        .eq('patient_id', patient.patient_id);
    
    if (updateError) return null;
    
    // Update user state
    await updateUserState(telegramUserId, {
        current_state: 'linked',
        linked_patient_id: patient.patient_id
    });
    
    return patient;
}

// Get upcoming appointments for patient
async function getUpcomingAppointments(patientId) {
    const { data, error } = await supabase
        .from('appointments')
        .select(`
            *,
            doctors (first_name, last_name)
        `)
        .eq('patient_id', patientId)
        .eq('status', 'scheduled')
        .gte('appointment_date', new Date().toISOString().split('T')[0])
        .order('appointment_date', { ascending: true })
        .order('appointment_time', { ascending: true });
    
    if (error) return [];
    return data || [];
}

// Get queue position for an appointment
async function getQueuePosition(appointmentDate, appointmentTime, currentId) {
    const { count, error } = await supabase
        .from('appointments')
        .select('*', { count: 'exact', head: true })
        .eq('appointment_date', appointmentDate)
        .eq('status', 'scheduled')
        .lt('appointment_time', appointmentTime);
    
    if (error) return 1;
    return count + 1;
}

// Cancel appointment
async function cancelAppointment(appointmentId, patientId) {
    const { error } = await supabase
        .from('appointments')
        .update({ status: 'cancelled' })
        .eq('appointment_id', appointmentId)
        .eq('patient_id', patientId);
    
    return !error;
}

// ========== BOT COMMANDS ==========

// Start command
bot.start(async (ctx) => {
    const telegramUserId = ctx.from.id;
    const userState = await getUserState(telegramUserId);
    const patient = await getPatientByTelegramId(telegramUserId);
    
    if (patient) {
        await updateUserState(telegramUserId, { current_state: 'linked', linked_patient_id: patient.patient_id });
        await showMainMenu(ctx, patient);
    } else {
        await updateUserState(telegramUserId, { current_state: 'awaiting_email', pending_email: null });
        ctx.reply('👋 Welcome! Please send your email address to link your account.');
    }
});

// Show main menu
async function showMainMenu(ctx, patient) {
    const keyboard = {
        reply_markup: {
            keyboard: [
                ['📅 My Appointments', '🎫 Queue Position'],
                ['❌ Cancel Appointment', '📝 Reschedule Appointment'],
                ['❓ Help']
            ],
            resize_keyboard: true
        }
    };
    
    ctx.reply(`✅ Welcome back ${patient.first_name} ${patient.last_name}!\n\nWhat would you like to do?`, keyboard);
}

// Handle text messages
bot.on('text', async (ctx) => {
    const telegramUserId = ctx.from.id;
    const text = ctx.message.text;
    const userState = await getUserState(telegramUserId);
    const patient = await getPatientByTelegramId(telegramUserId);
    
    // If user is not linked and not awaiting email
    if (!patient && (!userState || userState.current_state !== 'awaiting_email')) {
        ctx.reply('❌ Account not linked. Please send your email address to link your account.');
        await updateUserState(telegramUserId, { current_state: 'awaiting_email' });
        return;
    }
    
    // Awaiting email for linking
    if (userState?.current_state === 'awaiting_email' && !patient) {
        const email = text.trim().toLowerCase();
        const linkedPatient = await linkPatient(telegramUserId, email);
        
        if (linkedPatient) {
            await showMainMenu(ctx, linkedPatient);
        } else {
            ctx.reply('❌ Email not found. Please register on our website first, or try again with a different email.');
        }
        return;
    }
    
    // Awaiting appointment ID for cancellation
    if (userState?.current_state === 'awaiting_cancel') {
        const appointmentId = parseInt(text);
        if (isNaN(appointmentId)) {
            ctx.reply('❌ Please send a valid appointment ID number.');
            return;
        }
        
        const success = await cancelAppointment(appointmentId, patient.patient_id);
        if (success) {
            ctx.reply('✅ Appointment cancelled successfully.');
        } else {
            ctx.reply('❌ Failed to cancel appointment. Please check the appointment ID and try again.');
        }
        
        await updateUserState(telegramUserId, { current_state: 'linked' });
        await showMainMenu(ctx, patient);
        return;
    }
    
    // Handle menu options
    switch (text) {
        case '📅 My Appointments':
            const appointments = await getUpcomingAppointments(patient.patient_id);
            
            if (appointments.length === 0) {
                ctx.reply('📭 You have no upcoming appointments.');
            } else {
                let message = '📅 *Your Upcoming Appointments:*\n\n';
                for (let i = 0; i < appointments.length; i++) {
                    const apt = appointments[i];
                    const doctorName = apt.doctors ? `Dr. ${apt.doctors.first_name} ${apt.doctors.last_name}` : 'Doctor';
                    const date = new Date(apt.appointment_date).toLocaleDateString();
                    const queuePos = await getQueuePosition(apt.appointment_date, apt.appointment_time, apt.appointment_id);
                    
                    message += `${i + 1}. 📍 *ID: ${apt.appointment_id}*\n`;
                    message += `   📅 Date: ${date}\n`;
                    message += `   ⏰ Time: ${apt.appointment_time}\n`;
                    message += `   👨‍⚕️ Doctor: ${doctorName}\n`;
                    message += `   🎫 Queue Position: #${queuePos}\n\n`;
                }
                message += 'To cancel, type: ❌ Cancel Appointment';
                ctx.reply(message, { parse_mode: 'Markdown' });
            }
            break;
            
        case '🎫 Queue Position':
            const upcomingApps = await getUpcomingAppointments(patient.patient_id);
            
            if (upcomingApps.length === 0) {
                ctx.reply('🎫 You have no upcoming appointments to check queue position.');
            } else {
                const nextApp = upcomingApps[0];
                const queuePos = await getQueuePosition(nextApp.appointment_date, nextApp.appointment_time, nextApp.appointment_id);
                const date = new Date(nextApp.appointment_date).toLocaleDateString();
                
                ctx.reply(`🎫 *Your Queue Position*\n\n📅 Date: ${date}\n⏰ Time: ${nextApp.appointment_time}\n🎫 Your position: #${queuePos}\n\n👥 People ahead of you: ${queuePos - 1}`, { parse_mode: 'Markdown' });
            }
            break;
            
        case '❌ Cancel Appointment':
            const activeApps = await getUpcomingAppointments(patient.patient_id);
            
            if (activeApps.length === 0) {
                ctx.reply('❌ You have no upcoming appointments to cancel.');
            } else {
                let message = '📋 *Your appointments:*\n\n';
                for (const apt of activeApps) {
                    const date = new Date(apt.appointment_date).toLocaleDateString();
                    message += `🆔 ID: ${apt.appointment_id} - ${date} at ${apt.appointment_time}\n`;
                }
                message += '\n✏️ Please send the **appointment ID** you want to cancel.';
                ctx.reply(message, { parse_mode: 'Markdown' });
                await updateUserState(telegramUserId, { current_state: 'awaiting_cancel' });
            }
            break;
            
        case '📝 Reschedule Appointment':
            ctx.reply('📝 *Reschedule Feature*\n\nPlease contact the clinic directly at +213 XXX XX XX XX or visit our website to reschedule your appointment.\n\nAlternatively, you can cancel and book a new appointment.', { parse_mode: 'Markdown' });
            break;
            
        case '❓ Help':
            ctx.reply(`📖 *Help Menu*\n\n` +
                `🔹 *Send email* - Link your account\n` +
                `🔹 *📅 My Appointments* - View all upcoming appointments\n` +
                `🔹 *🎫 Queue Position* - Check your current queue position\n` +
                `🔹 *❌ Cancel Appointment* - Cancel an existing appointment\n` +
                `🔹 *📝 Reschedule Appointment* - Instructions to reschedule\n` +
                `🔹 *❓ Help* - Show this menu\n\n` +
                `📞 For urgent issues, call the clinic: +213 XXX XX XX XX`,
                { parse_mode: 'Markdown' });
            break;
            
        default:
            ctx.reply('❓ Unknown command. Please use the menu buttons or type /start to reset.');
    }
});

// Start the web server
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Bot webhook listening on port ${port}`);
});
