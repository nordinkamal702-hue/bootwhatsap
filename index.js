const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const ytSearch = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const axios = require('axios');
const fs = require('fs');
const gTTS = require('gtts'); 
const express = require('express'); // 1. استيراد Express
const QRCode = require('qrcode');   // 2. استيراد مكتبة qrcode لتحويل النص إلى صورة

const app = express();
const PORT = process.env.PORT || 3000;
let latestQR = null; // متغير لحفظ الـ QR Code الحالي

if (!fs.existsSync('./downloads')) {
    fs.mkdirSync('./downloads');
}

// إعداد خادم الويب لعرض الـ QR
app.get('/', async (req, res) => {
    if (!latestQR) {
        res.send(`
            <meta charset="utf-8">
            <div style="text-align: center; font-family: Arial; margin-top: 50px;">
                <h2>✅ البوت شغال ومربوط أو جاري التحميل...</h2>
                <p>إذا كان البوت غير مربوط، انتظر بضع ثوانٍ ثم قم بتحديث الصفحة.</p>
                <script>setTimeout(() => { location.reload(); }, 3000);</script>
            </div>
        `);
        return;
    }

    try {
        // تحويل نص الـ QR إلى Data URL لتقديمه كصورة في المتصفح
        const qrImage = await QRCode.toDataURL(latestQR);
        res.send(`
            <meta charset="utf-8">
            <div style="text-align: center; font-family: Arial; margin-top: 50px;">
                <h1>📱 ربط بوت الواتساب</h1>
                <p>سكان الـ QR Code أسفله عبر تطبيق الواتساب:</p>
                <div style="margin: 20px;"><img src="${qrImage}" style="width: 300px; height: 300px;"/></div>
                <p>🔄 ستتحدث الصفحة تلقائياً كل 5 ثوانٍ لجلب كود جديد إذا انتهت صلاحيته.</p>
                <script>
                    setTimeout(() => { location.reload(); }, 5000);
                </script>
            </div>
        `);
    } catch (err) {
        res.status(500).send('خطأ في توليد الـ QR Code');
    }
});

// تشغيل سيرفر الويب
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 صفحة الـ QR Code واجدة على الرابط: http://localhost:${PORT}`);
});

// إعداد Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" }); 

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const userSessions = {};

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ 
        auth: state,
        logger: require('pino')({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            latestQR = qr; // حفظ الـ QR لعرضه في المتصفح
            console.log('✨ كود الـ QR Code واجد في صفحة الويب! افتح: http://localhost:' + PORT);
        }
        
        if (connection === 'close') {
            latestQR = null; // تصفير الكود عند انقطاع الاتصال
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== 401;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            latestQR = null; // إخفاء الكود بمجرد نجاح الاتصال
            console.log('✅ البوت شغال بنظام التوليد النصي والتحويل الصوتي المضمون!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message ) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const cleanInput = text.trim();
        
        let command = cleanInput.split(' ')[0].toLowerCase();
        let args = cleanInput.substring(command.length).trim();

        // ----------------------------------------------------
        // معالجة اختيار الأرقام الذكي
        // ----------------------------------------------------
        if (userSessions[from]) {
            const session = userSessions[from];

            if (session.step === 'MAIN_MENU') {
                if (cleanInput === '1') { command = '!مباريات'; delete userSessions[from]; }
                else if (cleanInput === '2') { await sock.sendMessage(from, { text: '🎵 اكتب *!yt* متبوعاً باسم الأغنية اللي بغيتي.\nمثال: `!yt اغنية مغربية`' }); return delete userSessions[from]; }
                else if (cleanInput === '3') { await sock.sendMessage(from, { text: '🧠 اكتب *!gemini* متبوعاً بسؤالك مباشرة.' }); return delete userSessions[from]; }
            }
            
            else if (session.step === 'SELECT_MATCH' && /^[1-5]$/.test(cleanInput)) {
                const index = parseInt(cleanInput) - 1;
                const match = session.matches[index];
                if (match) {
                    await sock.sendMessage(from, { text: `🎙️ جاري تحليل الماتش بذكاء وتوليد الريكورد الصوتي...` });
                    try {
                        const matchDataPrompt = `المسابقة: ${match.competition.name} | الفريق المستضيف: ${match.homeTeam.name} | الفريق الضيف: ${match.awayTeam.name} | النتيجة: [ ${match.score.fullTime.home ?? 0} - ${match.score.fullTime.away ?? 0} ] | الحالة: ${match.status}`;
                        const aiPrompt = `أنت معلق ومحلل كروي مغربي حماسي تكتيكي وكوميدي. حلل النتيجة وعلّق على المباراة بالدارجة المغربية المفهومة وبأسلوب حماسي جداً وممتع. تنبيه مهم جداً: لا تضع أي رموز تعبيرية أو إيموجي أو نجمات أو علامات غريبة وسط النص نهائياً لكي يسهل تحويله إلى صوت نقي بدون مشاكل. ها هي الداتا:\n${matchDataPrompt}`;
                        
                        const result = await model.generateContent(aiPrompt);
                        const aiCommentary = result.response.text();

                        const ytRes = await ytSearch(`ملخص مباراة ${match.homeTeam.name} ضد ${match.awayTeam.name} اهداف`);
                        const topVideo = ytRes.videos[0];

                        const audioPath = `./downloads/commentary_${Date.now()}.mp3`;
                        const tts = new gTTS(aiCommentary, 'ar');
                        
                        tts.save(audioPath, async (err) => {
                            if (err) throw err;

                            let captionText = `🏆 *ملخص اللقاء:* ${match.homeTeam.name} vs ${match.awayTeam.name}\n\n📺 *شاهد الملخص على يوتيوب:*\n🔗 *الرابط:* ${topVideo ? topVideo.url : 'غير متوفر حالياً'}`;
                            
                            if (topVideo) {
                                await sock.sendMessage(from, { image: { url: topVideo.thumbnail }, caption: captionText });
                            } else {
                                await sock.sendMessage(from, { text: captionText });
                            }

                            await sock.sendMessage(from, { 
                                audio: { url: audioPath }, 
                                mimetype: 'audio/mp4', 
                                ptt: true 
                            });

                            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                        });

                        delete userSessions[from];
                    } catch (e) {
                        console.error(e);
                        delete userSessions[from];
                        await sock.sendMessage(from, { text: '❌ وقع مشكل أثناء معالجة بيانات المباراة أو توليد الصوت.' });
                    }
                    return;
                }
            }

            else if (session.step === 'SELECT_VIDEO' && /^[1-5]$/.test(cleanInput)) {
                const index = parseInt(cleanInput) - 1;
                session.selectedVideo = session.videos[index];
                session.step = 'SELECT_TYPE';
                await sock.sendMessage(from, {
                    image: { url: session.selectedVideo.thumbnail },
                    caption: `🎬 *اخترت:* ${session.selectedVideo.title}\n\n[ 1 ] 🎵 تحميل صوت فقط (Audio)\n[ 2 ] 🎥 تحميل فيديو كامل (Video)`
                });
                return;
            }
            else if (session.step === 'SELECT_TYPE' && /^[1-2]$/.test(cleanInput)) {
                if (cleanInput === '1') {
                    session.step = 'SELECT_AUDIO_QUALITY';
                    await sock.sendMessage(from, { text: `🎵 *اختر جودة الصوت:*\n\n[ 1 ] 💿 جودة عالية (320kbps)\n[ 2 ] 📱 جودة اقتصادية (128kbps)` });
                } else {
                    session.step = 'SELECT_QUALITY';
                    await sock.sendMessage(from, { text: `🎥 *اختر جودة الفيديو:*\n\n[ 1 ] 📉 خفيفة (360p)\n[ 2 ] 🎬 واضحة (720p)` });
                }
                return;
            }
            else if (session.step === 'SELECT_AUDIO_QUALITY' && /^[1-2]$/.test(cleanInput)) {
                const filePath = `./downloads/${Date.now()}.mp3`;
                const audioOptions = cleanInput === '1' ? { filter: 'audioonly', quality: 'highestaudio' } : { filter: 'audioonly', quality: 'lowestaudio' };
                await sock.sendMessage(from, { text: '⏳ جاري جلب وتحويل ملف الصوت... يرجى الانتظار.' });
                const videoUrl = session.selectedVideo.url;
                delete userSessions[from];

                try {
                    ytdl(videoUrl, audioOptions).pipe(fs.createWriteStream(filePath)).on('finish', async () => {
                        await sock.sendMessage(from, { audio: { url: filePath }, mimetype: 'audio/mp4', ptt: false });
                        fs.unlinkSync(filePath);
                    }).on('error', () => { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); });
                } catch (e) { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
                return;
            }
            else if (session.step === 'SELECT_QUALITY' && /^[1-2]$/.test(cleanInput)) {
                const filePath = `./downloads/${Date.now()}.mp4`;
                const qualityTag = cleanInput === '1' ? '18' : '22';
                await sock.sendMessage(from, { text: '⏳ جاري تحميل الفيديو المختار...' });
                const videoUrl = session.selectedVideo.url;
                delete userSessions[from];

                try {
                    ytdl(videoUrl, { quality: qualityTag }).pipe(fs.createWriteStream(filePath)).on('finish', async () => {
                        await sock.sendMessage(from, { video: { url: filePath }, caption: '✅ تم تحميل الفيديو!' });
                        fs.unlinkSync(filePath);
                    }).on('error', () => { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); });
                } catch (e) { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
                return;
            }
        }

        // ----------------------------------------------------
        // الأوامر المباشرة والـ Menu
        // ----------------------------------------------------
        if (command === '!menu' || command === '!الاعدادات' || command === '!البوت') {
            userSessions[from] = { step: 'MAIN_MENU' };
            const menuText = `🤖 *مرحباً بك في قائمة التحكم الذكية!* \n\n` +
                             `👇 *أرسل رقم الخيار لي بغيتي مباشرة:*\n\n` +
                             `[ 1 ] ⚽ *مباريات اليوم والتحليل الصوتي الحماسي*\n` +
                             `[ 2 ] 🎵 *تحميل الأغاني والفيديوهات من YT*\n` +
                             `[ 3 ] 🧠 *التحدث مع الذكاء الاصطناعي Gemini*\n\n` +
                             `⚙️ _تنويه: يمكنك كتابة الأوامر مباشرة مثل !مباريات أو !yt_`;
            await sock.sendMessage(from, { text: menuText });
        }

        else if (command === '!gemini') {
            if (!args) return sock.sendMessage(from, { text: '🤖 كتب السؤال ديالك بعد الأمر.' });
            try {
                const result = await model.generateContent(args);
                await sock.sendMessage(from, { text: result.response.text() });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ وقع خطأ أثناء الاتصال بـ Gemini.' });
            }
        }

        else if (command === '!matches' || command === '!مباريات') {
            try {
                await sock.sendMessage(from, { text: '🕒 جاري جلب مباريات اليوم...' });
                const response = await axios.get('https://api.football-data.org/v4/matches', {
                    headers: { 'X-Auth-Token': FOOTBALL_API_KEY }
                });

                const matches = response.data.matches.slice(0, 5);
                if (!matches || matches.length === 0) {
                    return sock.sendMessage(from, { text: '🚫 لا توجد مباريات كبرى مجدولة اليوم.' });
                }

                userSessions[from] = { step: 'SELECT_MATCH', matches: matches };

                let matchMenu = "📅 *مباريات اليوم المتاحة للتحليل والملخص:*\n\n👇 اختر رقم المباراة لي بغيتي تسمع ليها التحليل الصوتي:\n";
                matches.forEach((match, index) => {
                    matchMenu += `\n*${index + 1}.* 🏆 ${match.competition.name}\n⚽ ${match.homeTeam.name} vs ${match.awayTeam.name}\n`;
                });

                await sock.sendMessage(from, { text: matchMenu });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ تعذر جلب معلومات المباريات حالياً.' });
            }
        }

        else if (command === '!yt' || command === '!يوتيوب') {
            if (!args) return sock.sendMessage(from, { text: '🎵 اكتب اسم الفيديو أو الأغنية بعد الأمر.' });
            try {
                await sock.sendMessage(from, { text: '🔄 جاري البحث...' });
                const searchResults = await ytSearch(args);
                const videos = searchResults.videos.slice(0, 5);

                if (videos.length === 0) return sock.sendMessage(from, { text: '❌ لم يتم العثور على أي نتائج.' });

                userSessions[from] = { step: 'SELECT_VIDEO', videos: videos };

                let responseText = `🎵 *نتائج البحث عن:* ${args}\n\n👇 اختر رقم الفيديو وصيفطو مباشرة:\n`;
                videos.forEach((video, index) => {
                    responseText += `\n*${index + 1}.* ${video.title}\n⏱️ المدا: ${video.timestamp}\n`;
                });
                await sock.sendMessage(from, { text: responseText });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ وقع مشكل أثناء البحث.' });
            }
        }
    });
}

startBot().catch(err => console.error(err));