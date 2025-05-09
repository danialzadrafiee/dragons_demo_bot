const { Telegraf } = require('telegraf');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const express = require('express');

// Environment configuration
const config = {
   TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
   OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
   MODEL: process.env.OPENROUTER_MODEL,
   SOURCE_CHANNEL_ID: process.env.SOURCE_CHANNEL_ID,
   TARGET_CHANNEL_ID: process.env.TARGET_CHANNEL_ID,
   MODE: process.env.MODE || 'demo',
   WEBHOOK_URL: process.env.WEBHOOK_URL,
   PORT: process.env.PORT || 3000,
   AI_PROMPT: `You translate forex and trading signals from English to Persian. Keep all technical terms, symbols, numbers, and emojis intact. Provide ONLY the direct translation with no explanations or parentheses. This is for a trading signals channel.
   Use a friendly, conversational tone in translations rather than formal/bookish language, while maintaining high quality translations.
   The following terms MUST remain in English:
   buy - sell - buy limit - sell limit - buy stop - sell stop - TP - Take profit - Stop - Stop loss - Sl`
};

const prisma = new PrismaClient();
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
console.log('Bot initialized with token');
console.log(`Monitoring source channel: ${config.SOURCE_CHANNEL_ID}, target channel: ${config.TARGET_CHANNEL_ID}`);
console.log(`Mode: ${config.MODE}`);

async function translateToPersian(text) {
   if (!text) return null;
   console.log('Translating text:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));

   try {
       const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
           model: config.MODEL,
           messages: [
               { role: 'system', content: config.AI_PROMPT },
               { role: 'user', content: text }
           ],
           temperature: 0.1
       }, {
           headers: {
               'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
               'Content-Type': 'application/json'
           }
       });

       if (response.data?.choices?.[0]?.message?.content) {
           let translation = response.data.choices[0].message.content.trim();
           translation = translation.replace(/\([^)]*\)/g, '');
           console.log('Translation successful');
           return translation;
       }
       console.log('Translation returned no content');
       return null;
   } catch (error) {
       console.error('Translation error:', error.message);
       return null;
   }
}

// Save message to database
async function saveMessageToDatabase(msgObj, chatId) {
   try {
       return await prisma.channelMessage.create({
           data: {
               messageId: msgObj.message_id,
               chatId: chatId.toString(),
               date: new Date(msgObj.date * 1000),
               text: msgObj.text || null,
               isReply: Boolean(msgObj.reply_to_message),
               replyToMessageId: msgObj.reply_to_message?.message_id || null,
               metadata: JSON.stringify({
                   from: msgObj.from,
                   entities: msgObj.entities,
                   replyTo: msgObj.reply_to_message?.message_id || null,
               }),
           }
       });
   } catch (error) {
       console.error('Database error when saving message:', error);
       return null;
   }
}

// Find reply target message ID
async function findReplyTargetMessageId(replyToMessageId) {
   if (!replyToMessageId) return null;

   try {
       const originalRepliedMessage = await prisma.channelMessage.findFirst({
           where: {
               messageId: replyToMessageId,
               chatId: config.SOURCE_CHANNEL_ID
           },
           include: { translation: true }
       });

       return originalRepliedMessage?.translation?.targetMessageId || null;
   } catch (error) {
       console.error('Error finding reply message:', error);
       return null;
   }
}

// Save translation data
async function saveTranslation(originalMessageId, translatedText, targetMessageId, translationTime, status = 'success', errorMessage = null) {
   try {
       await prisma.translatedMessage.create({
           data: {
               originalMessageId,
               translatedText,
               targetChannelId: config.TARGET_CHANNEL_ID,
               targetMessageId,
               translationTimeMs: translationTime,
               createdAt: new Date(),
               status,
               errorMessage
           }
       });
       console.log('Translation saved to database');
   } catch (error) {
       console.error('Error saving translation to database:', error);
   }
}

// Handle message edits in source channel
bot.on('edited_channel_post', async (ctx) => {
    try {
        // Check if edit is from source channel
        if (!ctx.chat || ctx.chat.id.toString() !== config.SOURCE_CHANNEL_ID) {
            return;
        }

        console.log('Edit detected in source channel');
        const editedMsg = ctx.editedChannelPost;
        if (!editedMsg || !editedMsg.text) {
            console.log('No text in edited message');
            return;
        }

        // Find the original message in database
        const originalMessage = await prisma.channelMessage.findFirst({
            where: {
                messageId: editedMsg.message_id,
                chatId: config.SOURCE_CHANNEL_ID
            },
            include: { translation: true }
        });

        if (!originalMessage || !originalMessage.translation) {
            console.log('Original message or translation not found in database');
            return;
        }

        const startTime = Date.now();

        // Translate the edited text
        const translatedText = await translateToPersian(editedMsg.text);
        if (!translatedText) {
            console.log('No translation produced for edited message');
            return;
        }

        // Calculate translation time
        const translationTime = Date.now() - startTime;

        // Update the message in target channel
        try {
            await ctx.telegram.editMessageText(
                config.TARGET_CHANNEL_ID, 
                originalMessage.translation.targetMessageId, 
                undefined, 
                translatedText
            );

            // Update translation record - removing updatedAt field which doesn't exist in schema
            await prisma.translatedMessage.update({
                where: { id: originalMessage.translation.id },
                data: {
                    translatedText,
                    translationTimeMs: translationTime,
                    status: 'updated'
                }
            });

            // Update original message text
            await prisma.channelMessage.update({
                where: { id: originalMessage.id },
                data: { text: editedMsg.text }
            });

            console.log('Target channel message updated successfully');
        } catch (error) {
            console.error('Error updating message in target channel:', error);
            
            // Save failed update - removing updatedAt field which doesn't exist in schema
            await prisma.translatedMessage.update({
                where: { id: originalMessage.translation.id },
                data: {
                    translatedText,
                    translationTimeMs: translationTime,
                    status: 'update_failed',
                    errorMessage: error.message
                }
            });
        }
    } catch (error) {
        console.error('Error processing edited message:', error);
    }
});

// Main message handler
bot.on(['message', 'channel_post'], async (ctx) => {
   try {
       // Check if message is from source channel
       if (!ctx.chat || ctx.chat.id.toString() !== config.SOURCE_CHANNEL_ID) {
           return;
       }

       console.log('Message from source channel detected');
       const msgObj = ctx.message || ctx.channelPost || ctx.update.channel_post;
       if (!msgObj || !msgObj.text) {
           console.log('No text message found');
           return;
       }

       const startTime = Date.now();

       // Save message to database
       const savedMessage = await saveMessageToDatabase(msgObj, ctx.chat.id);
       if (!savedMessage) return;

       // Translate text
       const translatedText = await translateToPersian(msgObj.text);
       if (!translatedText) {
           console.log('No translation produced');
           return;
       }

       // Calculate translation time
       const translationTime = Date.now() - startTime;

       // Find reply target if this is a reply
       const replyToTargetMessageId = await findReplyTargetMessageId(msgObj.reply_to_message?.message_id);

       // Send translated message to target channel
       try {
           const options = replyToTargetMessageId ? { reply_to_message_id: replyToTargetMessageId } : {};
           const result = await ctx.telegram.sendMessage(config.TARGET_CHANNEL_ID, translatedText, options);

           // Save successful translation
           await saveTranslation(savedMessage.id, translatedText, result.message_id, translationTime);
       } catch (error) {
           console.error('Error forwarding message:', error);

           // Save failed translation
           await saveTranslation(savedMessage.id, translatedText, null, translationTime, 'failed', error.message);
       }

   } catch (error) {
       console.error('Error processing message:', error);
   }
});

// Setup based on mode
if (config.MODE === 'prod') {
   // Production mode - use webhook
   const app = express();
   app.use(express.json());
   
   // Set webhook path
   const webhookPath = new URL(config.WEBHOOK_URL).pathname || '';
   
   // Register webhook handler
   app.post(webhookPath, (req, res) => {
       bot.handleUpdate(req.body, res);
   });
   
   // Setup webhook with Telegram
   bot.telegram.setWebhook(config.WEBHOOK_URL)
       .then(() => {
           console.log(`Webhook set to ${config.WEBHOOK_URL}`);
           
           // Start Express server
           app.listen(config.PORT, () => {
               console.log(`Express server is listening on port ${config.PORT}`);
               
               // Test database connection
               prisma.$connect()
                   .then(() => console.log('Database connection successful'))
                   .catch(err => console.error('Database connection error:', err));
               
               // Check bot permissions
               bot.telegram.getMe()
                   .then(botInfo => console.log(`Bot info: @${botInfo.username} (${botInfo.id})`))
                   .catch(err => console.error('Error getting bot info:', err));
           });
       })
       .catch(err => console.error('Failed to set webhook:', err));
} else {
   // Demo mode - use polling
   bot.launch()
       .then(() => {
           console.log('Bot started in polling mode successfully');
           
           // Test database connection
           prisma.$connect()
               .then(() => console.log('Database connection successful'))
               .catch(err => console.error('Database connection error:', err));
           
           // Check bot permissions
           bot.telegram.getMe()
               .then(botInfo => console.log(`Bot info: @${botInfo.username} (${botInfo.id})`))
               .catch(err => console.error('Error getting bot info:', err));
       })
       .catch(err => console.error('Bot failed to start:', err));
}

// Enable graceful stop
process.once('SIGINT', () => {
   bot.stop('SIGINT');
   prisma.$disconnect();
});
process.once('SIGTERM', () => {
   bot.stop('SIGTERM');
   prisma.$disconnect();
});