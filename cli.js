// bot.js
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fetch = require('node-fetch');
require('dotenv').config();

class TradingSignalsBot {
    constructor() {
        this.apiId = parseInt(process.env.TELEGRAM_API_ID);
        this.apiHash = process.env.TELEGRAM_API_HASH;
        this.sessionString = process.env.TELEGRAM_SESSION_STRING;
        this.botToken = process.env.TELEGRAM_BOT_TOKEN;
        
        // تبدیل ID ها به BigInt مثل کد قبلیتون
        this.sourceChannelId = process.env.SOURCE_CHANNEL_ID;
        this.targetChannelId = process.env.TARGET_CHANNEL_ID;
        
        this.openRouterApiKey = process.env.OPENROUTER_API_KEY;
        this.openRouterModel = process.env.OPENROUTER_MODEL;
        this.aiPrompt = process.env.AI_PROMPT;
        
        this.client = null;
        this.processedMessages = new Set();
    }

    async initialize() {
        try {
            const stringSession = new StringSession(this.sessionString);
            
            this.client = new TelegramClient(stringSession, this.apiId, this.apiHash, {
                connectionRetries: 5,
                retryDelay: 1000,
                autoReconnect: true,
            });

            console.log('🔄 در حال اتصال به تلگرام...');
            
            await this.client.start({
                botAuthToken: this.botToken,
            });

            console.log('✅ ربات با موفقیت متصل شد');
            
            await this.setupEventHandlers();
            
        } catch (error) {
            console.error('❌ خطا در اتصال:', error);
            throw error;
        }
    }

    async setupEventHandlers() {
        try {
            this.client.addEventHandler(async (event) => {
                await this.handleNewMessage(event);
            }, new NewMessage({}));

            console.log('✅ Event handler تنظیم شد');
        } catch (error) {
            console.error('❌ خطا در تنظیم event handler:', error);
        }
    }

    async handleNewMessage(event) {
        try {
            const message = event.message;
            const chatId = message.chatId || message.peerId?.channelId;
            
            console.log('🔍 پیام جدید دریافت شد:');
            console.log(`   📝 متن: ${message.text ? message.text.substring(0, 50) + '...' : 'متن ندارد'}`);
            console.log(`   🆔 Chat ID: ${chatId}`);
            console.log(`   🔢 Source Channel ID: ${this.sourceChannelId}`);
            
            // بررسی اینکه پیام از کانال سورس آمده - دقیقاً مثل کد قبلیتون
            if (!chatId || chatId.toString() !== this.sourceChannelId.replace('-100', '')) {
                console.log('⚠️ پیام از کانال سورس نیست - نادیده گرفته شد');
                return;
            }

            console.log('✅ پیام از کانال سورس تشخیص داده شد');
            
            if (!message.text) {
                console.log('⚠️ پیام متنی نیست');
                return;
            }

            const messageId = message.id;
            
            if (this.processedMessages.has(messageId)) {
                console.log('⚠️ این پیام قبلاً پردازش شده');
                return;
            }
            
            this.processedMessages.add(messageId);

            console.log('📨 شروع پردازش پیام از کانال سورس');
            
            const translatedText = await this.translateMessage(message.text);
            
            if (translatedText) {
                await this.sendToTargetChannel(translatedText);
                console.log('✅ پیام ترجمه شده ارسال شد');
            } else {
                console.log('❌ ترجمه ناموفق بود');
            }
        } catch (error) {
            console.error('❌ خطا در پردازش پیام:', error);
        }
    }

    async translateMessage(text) {
        try {
            console.log('🔄 در حال ترجمه...');
            
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.openRouterApiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.openRouterModel,
                    messages: [
                        {
                            role: 'system',
                            content: this.aiPrompt
                        },
                        {
                            role: 'user',
                            content: text
                        }
                    ],
                    temperature: 0.1
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
            }

            const data = await response.json();
            let translatedText = data.choices[0]?.message?.content?.trim();
            
            if (translatedText) {
                // حذف پرانتزها مثل کد قبلیتون
                translatedText = translatedText.replace(/\([^)]*\)/g, '');
                console.log('✅ ترجمه موفق');
                return translatedText;
            } else {
                console.log('❌ پاسخ ترجمه خالی بود');
                return null;
            }
        } catch (error) {
            console.error('❌ خطا در ترجمه:', error);
            return null;
        }
    }

    async sendToTargetChannel(text) {
        try {
            console.log('🔄 در حال ارسال به کانال تارگت...');
            
            // دقیقاً مثل کد قبلیتون
            const targetChannelId = this.targetChannelId.replace('-100', '');
            console.log(`🎯 Target Channel ID: ${targetChannelId}`);
            
            const result = await this.client.sendMessage(targetChannelId, {
                message: text
            });
            
            console.log('✅ پیام با موفقیت ارسال شد');
            console.log(`📨 Message ID: ${result.id}`);
        } catch (error) {
            console.error('❌ خطا در ارسال پیام:', error);
            console.error('خطای کامل:', error);
            
            // تلاش مجدد با BigInt
            try {
                console.log('🔄 تلاش مجدد با BigInt...');
                const targetChannelBigInt = BigInt(this.targetChannelId.replace('-100', ''));
                
                const result = await this.client.sendMessage(targetChannelBigInt, {
                    message: text
                });
                
                console.log('✅ پیام با BigInt ارسال شد');
            } catch (error2) {
                console.error('❌ خطا در تلاش دوم:', error2);
                
                // تلاش سوم با ID کامل
                try {
                    console.log('🔄 تلاش سوم با ID کامل...');
                    const result = await this.client.sendMessage(this.targetChannelId, {
                        message: text
                    });
                    console.log('✅ پیام با ID کامل ارسال شد');
                } catch (error3) {
                    console.error('❌ همه تلاش‌ها ناموفق:', error3);
                    throw error3;
                }
            }
        }
    }

    async start() {
        console.log('🚀 در حال راه‌اندازی ربات ترجمه سیگنال‌های تریدینگ...');
        
        try {
            await this.initialize();
            
            console.log('🔄 ربات در حال اجرا و منتظر پیام‌های جدید...');
            console.log(`📡 کانال سورس: ${this.sourceChannelId}`);
            console.log(`📤 کانال تارگت: ${this.targetChannelId}`);
            
            process.on('SIGINT', async () => {
                console.log('\n🛑 در حال بستن ربات...');
                if (this.client) {
                    await this.client.disconnect();
                }
                process.exit(0);
            });
            
        } catch (error) {
            console.error('❌ خطا در راه‌اندازی ربات:', error);
            process.exit(1);
        }
    }
}

if (require.main === module) {
    const bot = new TradingSignalsBot();
    bot.start().catch((error) => {
        console.error('❌ خطای کلی:', error);
        process.exit(1);
    });
}

module.exports = TradingSignalsBot;