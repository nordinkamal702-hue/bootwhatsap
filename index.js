const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
require('dotenv').config();
const express = require('express'); 
const QRCode = require('qrcode'); 
const ytSearch = require('yt-search');
const fs = require('fs');
const path = require('path');
const ytDlp = require('yt-dlp-exec'); 
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg'); // جلب مسار ffmpeg تلقائياً

const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = null; 

app.get('/', async (req, res) => {
    if (!latestQR) {
        res.send(`<meta charset="utf-8"><div style="text-align: center; margin-top: 50px;"><h2>✅ بوت التحميل الذاتي (محرك yt-dlp) شغال...</h2></div>`);
        return;
    }
    try {
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`<meta charset="utf-8"><div style="text-align: center; margin-top: 50px;"><h1>📱 ربط البوت</h1><img src="${qrImage}" style="width: 300px"/></div>`);
    } catch (err) { res.status(500).send('خطأ'); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🌐 السيرفر جاهز على منفذ: ${PORT}`));

const userSessions = {};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ auth: state, logger: require('pino')({ level: 'silent' }) });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) latestQR = qr;
        if (connection === 'open') { latestQR = null; console.log('✅ بوت قنص الميديا بمحرك yt-dlp جاهز ومستقر 100%!'); }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const cleanInput = text.trim();
        
        let command = cleanInput.split(' ')[0].toLowerCase();
        let args = cleanInput.substring(command.length).trim();

        if (userSessions[from]) {
            const session = userSessions[from];

            if (session.step === 'SELECT_VIDEO' && /^[1-5]$/.test(cleanInput)) {
                const index = parseInt(cleanInput) - 1;
                const selectedVideo = session.videos[index];
                
                session.selectedVideo = selectedVideo;
                session.step = 'SELECT_FORMAT';

                let formatText = `🎬 *لقد اخترت:* ${selectedVideo.title}\n⏱️ *المدة:* ${selectedVideo.timestamp}\n\n` +
                                 `👇 *رد برقم نوع التحميل المطلوب:*\n\n` +
                                 `[ 1 ] 🎵 ملف صوتي عالي الجودة (MP3)\n` +
                                 `[ 2 ] 🎥 ملف فيديو مباشر (MP4)`;
                
                await sock.sendMessage(from, { image: { url: selectedVideo.thumbnail }, caption: formatText });
                return;
            }

            else if (session.step === 'SELECT_FORMAT' && (cleanInput === '1' || cleanInput === '2')) {
                const choice = cleanInput;
                const videoUrl = session.selectedVideo.url;
                const isAudio = (choice === '1');
                delete userSessions[from]; 

                await sock.sendMessage(from, { text: `⏳ جارٍ استخلاص الميديا وحقنها عبر محرك yt-dlp الذكي... قد يستغرق الأمر لحظات.` });

                // تعديل: إذا كان الخيار صوت، نجعل الامتداد المؤقت mp3 مباشرة لتجنب مشاكل التسمية
                const tempFileName = `media_${Date.now()}.${isAudio ? 'mp3' : 'mp4'}`;
                const tempFilePath = path.join(__dirname, tempFileName);

                try {
                    const params = {
                        output: tempFilePath,
                        noCheckCertificates: true,
                        noWarnings: true,
                        preferFreeFormats: true,
                        extractorArgs: 'youtube:player-client=android,web',
                        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        // تمرير مسار المسير الذكي لـ ffmpeg لكي ينجح استخراج الـ MP3 على ويندوز
                        ffmpegLocation: ffmpegInstaller.path
                    };

                    if (isAudio) {
                        params.extractAudio = true;
                        params.audioFormat = 'mp3';
                        params.format = 'bestaudio/best';
                    } else {
                        params.format = 'best[ext=mp4][height<=720]/best';
                    }

                    await ytDlp(videoUrl, params);

                    if (fs.existsSync(tempFilePath)) {
                        const stats = fs.statSync(tempFilePath);
                        if (stats.size > 10 * 1024) { 
                            if (isAudio) {
                                await sock.sendMessage(from, { 
                                    audio: { url: tempFilePath }, 
                                    mimetype: 'audio/mp4', 
                                    ptt: false 
                                });
                            } else {
                                await sock.sendMessage(from, { 
                                    video: { url: tempFilePath }, 
                                    caption: '✅ تم التحميل بنجاح تام وبأعلى سرعة استخلاص!' 
                                });
                            }
                        } else {
                            await sock.sendMessage(from, { text: '❌ الملف المستخرج تالف أو بحجم غير منطقي.' });
                        }
                        
                        // حذف الملف بعد الإرسال الناجح
                        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); 
                    } else {
                        await sock.sendMessage(from, { text: '❌ فشل محرك التحويل في العثور على الملف المستخرج.' });
                    }

                } catch (downloadError) {
                    console.error("خطأ أثناء معالجة yt-dlp:", downloadError.message);
                    await sock.sendMessage(from, { text: '❌ واجه المحرك مشكلة أثناء معالجة الملف، يرجى المحاولة مجدداً.' });
                    
                    // إصلاح: التأكد من حذف الملف المؤقت (فيديو أو صوت) فوراً عند حدوث الخطأ لمنع تراكم الملفات
                    if (fs.existsSync(tempFilePath)) {
                        try { fs.unlinkSync(tempFilePath); } catch (e) { console.error("فشل حذف الملف المؤقت:", e.message); }
                    }
                }
                return;
            }
        }

        if (command === '!yt' || command === '!down' || command === '!تحميل') {
            if (!args) return sock.sendMessage(from, { text: '🎵 اكتب اسم المقطع أو ضع الرابط مباشرة بعد الأمر.' });
            
            try {
                if (args.includes('youtube.com') || args.includes('youtu.be')) {
                    userSessions[from] = { 
                        step: 'SELECT_FORMAT', 
                        selectedVideo: { url: args, title: 'رابط مباشر', timestamp: 'غير محددة', thumbnail: 'https://img.youtube.com/vi/default/0.jpg' } 
                    };
                    await sock.sendMessage(from, { text: `🔗 تم رصد الرابط بنجاح.\n\n[ 1 ] 🎵 تحميل صوتي (MP3)\n[ 2 ] 🎥 تحميل فيديو (MP4)\n\nرد برقم خيارك مباشرة:` });
                    return;
                }

                await sock.sendMessage(from, { text: '🔍 جاري البحث في يوتيوب...' });
                const searchResults = await ytSearch(args);
                const videos = searchResults.videos.slice(0, 5);

                if (videos.length === 0) return sock.sendMessage(from, { text: '❌ لم يتم العثور على نتائج للبحث.' });

                userSessions[from] = { step: 'SELECT_VIDEO', videos: videos };

                let responseText = `🎵 *نتائج البحث لـ:* ${args}\n\n👇 *رد برقم الفيديو المطلوب مباشرة (من 1 إلى 5):*\n`;
                videos.forEach((video, index) => {
                    responseText += `\n*${index + 1}.* ${video.title}\n⏱️ المدة: ${video.timestamp}\n`;
                });
                
                await sock.sendMessage(from, { text: responseText });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ واجه البوت مشكلة في معالجة البحث حالياً.' });
            }
        }
    });
}

startBot().catch(err => console.error(err));