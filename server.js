require('dotenv').config();

const express = require('express');
const axios = require('axios');
const multer = require('multer');
const { Pool } = require('pg');
const Redis = require('redis');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

console.log('Environment check:');
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_PASSWORD:', process.env.DB_PASSWORD ? 'SET' : 'NOT SET');
console.log('DB_NAME:', process.env.DB_NAME);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database Configuration (PostgreSQL)
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'whatsapp_bot',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Redis for caching and session management
const redis = Redis.createClient({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
});

// WhatsApp Business API Configuration
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Database Schema Setup
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number VARCHAR(20) NOT NULL,
        user_name VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id),
        message_id VARCHAR(100) UNIQUE,
        phone_number VARCHAR(20) NOT NULL,
        message_type VARCHAR(20) NOT NULL,
        content TEXT,
        media_url VARCHAR(500),
        media_type VARCHAR(50),
        direction VARCHAR(10) NOT NULL, -- 'inbound' or 'outbound'
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) DEFAULT 'sent',
        metadata JSONB
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number VARCHAR(20) NOT NULL,
        session_data JSONB,
        current_step VARCHAR(100),
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone_number);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone_number);
      CREATE INDEX IF NOT EXISTS idx_sessions_phone ON bot_sessions(phone_number);
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Utility Functions
class WhatsAppService {
  static async sendMessage(phoneNumber, message) {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          text: { body: message }
        },
        {
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('WhatsApp send message error:', error.response?.data || error.message);
      throw error;
    }
  }

  static async sendMedia(phoneNumber, mediaUrl, mediaType, caption = '') {
    try {
      const mediaObject = {};
      mediaObject[mediaType] = {
        link: mediaUrl
      };
      
      if (caption) {
        mediaObject[mediaType].caption = caption;
      }

      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: mediaType,
          ...mediaObject
        },
        {
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('WhatsApp send media error:', error.response?.data || error.message);
      throw error;
    }
  }

  static async sendInteractiveMessage(phoneNumber, header, body, buttons) {
    try {
      const response = await axios.post(
        `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          type: 'interactive',
          interactive: {
            type: 'button',
            header: { type: 'text', text: header },
            body: { text: body },
            action: {
              buttons: buttons.map((btn, index) => ({
                type: 'reply',
                reply: { id: `btn_${index}`, title: btn }
              }))
            }
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('WhatsApp send interactive message error:', error.response?.data || error.message);
      throw error;
    }
  }
}

class DatabaseService {
  static async getOrCreateConversation(phoneNumber, userName = null) {
    try {
      let result = await pool.query(
        'SELECT * FROM conversations WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1',
        [phoneNumber]
      );

      if (result.rows.length === 0) {
        result = await pool.query(
          'INSERT INTO conversations (phone_number, user_name) VALUES ($1, $2) RETURNING *',
          [phoneNumber, userName]
        );
      }

      return result.rows[0];
    } catch (error) {
      console.error('Database conversation error:', error);
      throw error;
    }
  }

  static async saveMessage(conversationId, messageId, phoneNumber, messageType, content, mediaUrl, mediaType, direction, metadata = {}) {
    try {
      const result = await pool.query(
        `INSERT INTO messages 
         (conversation_id, message_id, phone_number, message_type, content, media_url, media_type, direction, metadata) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
         ON CONFLICT (message_id) DO NOTHING
         RETURNING *`,
        [conversationId, messageId, phoneNumber, messageType, content, mediaUrl, mediaType, direction, JSON.stringify(metadata)]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Database save message error:', error);
      throw error;
    }
  }

  static async getConversationHistory(phoneNumber, limit = 50) {
    try {
      const result = await pool.query(
        `SELECT m.* FROM messages m
         JOIN conversations c ON m.conversation_id = c.id
         WHERE c.phone_number = $1
         ORDER BY m.timestamp DESC
         LIMIT $2`,
        [phoneNumber, limit]
      );
      return result.rows.reverse(); // Return chronological order
    } catch (error) {
      console.error('Database get history error:', error);
      throw error;
    }
  }

  static async saveSession(phoneNumber, sessionData, currentStep, expiresAt) {
    try {
      await pool.query(
        `INSERT INTO bot_sessions (phone_number, session_data, current_step, expires_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone_number) DO UPDATE SET
         session_data = $2, current_step = $3, expires_at = $4, updated_at = CURRENT_TIMESTAMP`,
        [phoneNumber, JSON.stringify(sessionData), currentStep, expiresAt]
      );
    } catch (error) {
      console.error('Database save session error:', error);
      throw error;
    }
  }

  static async getSession(phoneNumber) {
    try {
      const result = await pool.query(
        'SELECT * FROM bot_sessions WHERE phone_number = $1 AND expires_at > CURRENT_TIMESTAMP',
        [phoneNumber]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Database get session error:', error);
      throw error;
    }
  }
}

// Bot Logic Handler
class BotHandler {
  static async processMessage(phoneNumber, messageText, messageId, userName = null) {
    try {
      // Get or create conversation
      const conversation = await DatabaseService.getOrCreateConversation(phoneNumber, userName);
      
      // Save incoming message
      await DatabaseService.saveMessage(
        conversation.id,
        messageId,
        phoneNumber,
        'text',
        messageText,
        null,
        null,
        'inbound'
      );

      // Get current session
      let session = await DatabaseService.getSession(phoneNumber);
      if (!session) {
        session = {
          phone_number: phoneNumber,
          session_data: {},
          current_step: 'welcome',
          expires_at: new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
        };
      }

      // Process based on current step
      const response = await this.handleStep(session, messageText, conversation);
      
      // Send response
      if (response.type === 'text') {
        await WhatsAppService.sendMessage(phoneNumber, response.content);
      } else if (response.type === 'media') {
        await WhatsAppService.sendMedia(phoneNumber, response.url, response.mediaType, response.caption);
      } else if (response.type === 'interactive') {
        await WhatsAppService.sendInteractiveMessage(phoneNumber, response.header, response.body, response.buttons);
      }

      // Save outbound message
      await DatabaseService.saveMessage(
        conversation.id,
        `out_${Date.now()}`,
        phoneNumber,
        response.type,
        response.content || response.body,
        response.url,
        response.mediaType,
        'outbound'
      );

      // Update session
      await DatabaseService.saveSession(
        phoneNumber,
        response.sessionData || session.session_data,
        response.nextStep || session.current_step,
        new Date(Date.now() + 30 * 60 * 1000)
      );

    } catch (error) {
      console.error('Bot processing error:', error);
      await WhatsAppService.sendMessage(phoneNumber, 'Sorry, I encountered an error. Please try again.');
    }
  }

  static async handleStep(session, messageText, conversation) {
    const sessionData = session.session_data || {};
    
    switch (session.current_step) {
      case 'welcome':
        return {
          type: 'interactive',
          header: 'Welcome! 👋',
          body: 'What would you like to do today?',
          buttons: ['Generate Image', 'Generate Video', 'Get Information'],
          nextStep: 'menu_selection',
          sessionData
        };

      case 'menu_selection':
        if (messageText.includes('Generate Image') || messageText.toLowerCase().includes('image')) {
          return {
            type: 'text',
            content: 'Great! Please describe the image you want me to generate.',
            nextStep: 'image_input',
            sessionData: { ...sessionData, service: 'image' }
          };
        } else if (messageText.includes('Generate Video') || messageText.toLowerCase().includes('video')) {
          return {
            type: 'text',
            content: 'Awesome! Please describe the video you want me to create.',
            nextStep: 'video_input',
            sessionData: { ...sessionData, service: 'video' }
          };
        } else if (messageText.includes('Get Information') || messageText.toLowerCase().includes('information')) {
          return {
            type: 'text',
            content: 'What information would you like me to help you find?',
            nextStep: 'info_input',
            sessionData: { ...sessionData, service: 'info' }
          };
        }
        return {
          type: 'text',
          content: 'Please select one of the options: Generate Image, Generate Video, or Get Information.',
          nextStep: 'menu_selection',
          sessionData
        };

      case 'image_input':
        // Call your custom API for image generation
        const imageResult = await this.callCustomAPI('image', { prompt: messageText, user: conversation.phone_number });
        return {
          type: 'media',
          url: imageResult.imageUrl,
          mediaType: 'image',
          caption: `Here's your generated image based on: "${messageText}"`,
          nextStep: 'welcome',
          sessionData: {}
        };

      case 'video_input':
        // Call your custom API for video generation
        const videoResult = await this.callCustomAPI('video', { prompt: messageText, user: conversation.phone_number });
        return {
          type: 'media',
          url: videoResult.videoUrl,
          mediaType: 'video',
          caption: `Here's your generated video: "${messageText}"`,
          nextStep: 'welcome',
          sessionData: {}
        };

      case 'info_input':
        // Call your custom API for information
        const infoResult = await this.callCustomAPI('info', { query: messageText, user: conversation.phone_number });
        return {
          type: 'text',
          content: infoResult.response,
          nextStep: 'welcome',
          sessionData: {}
        };

      default:
        return {
          type: 'text',
          content: 'Hi! Type "start" to begin or "menu" to see options.',
          nextStep: 'welcome',
          sessionData: {}
        };
    }
  }

  static async callCustomAPI(service, data) {
    try {
      // Replace these URLs with your actual API endpoints
      const apiEndpoints = {
        image: process.env.IMAGE_API_URL || 'http://localhost:3001/api/generate-image',
        video: process.env.VIDEO_API_URL || 'http://localhost:3001/api/generate-video',
        info: process.env.INFO_API_URL || 'http://localhost:3001/api/get-info'
      };

      const response = await axios.post(apiEndpoints[service], data, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CUSTOM_API_TOKEN}`
        },
        timeout: 30000 // 30 seconds timeout
      });

      return response.data;
    } catch (error) {
      console.error(`Custom API call error for ${service}:`, error.message);
      // Return fallback response
      return {
        imageUrl: 'https://via.placeholder.com/400x400?text=Error+Generating+Image',
        videoUrl: 'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_1mb.mp4',
        response: 'Sorry, I could not process your request right now. Please try again later.'
      };
    }
  }
}

// Routes

// WhatsApp Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Forbidden');
  }
});

// WhatsApp Webhook Handler
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      body.entry?.forEach(entry => {
        entry.changes?.forEach(change => {
          if (change.field === 'messages') {
            const messages = change.value.messages;
            if (messages) {
              messages.forEach(async (message) => {
                const phoneNumber = message.from;
                const messageId = message.id;
                const messageText = message.text?.body;
                const userName = change.value.contacts?.[0]?.profile?.name;

                if (messageText) {
                  await BotHandler.processMessage(phoneNumber, messageText, messageId, userName);
                }
              });
            }
          }
        });
      });
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// API Routes for manual testing and management

// Send message manually
app.post('/api/send-message', async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;
    const result = await WhatsAppService.sendMessage(phoneNumber, message);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get conversation history
app.get('/api/conversations/:phoneNumber/history', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const { limit = 50 } = req.query;
    const history = await DatabaseService.getConversationHistory(phoneNumber, parseInt(limit));
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all conversations
app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Initialize and start server
async function startServer() {
  try {
    await initializeDatabase();
    await redis.connect();
    
    app.listen(PORT, () => {
      console.log(`WhatsApp Bot Server running on port ${PORT}`);
      console.log(`Webhook URL: http://your-domain.com/webhook`);
    });
  } catch (error) {
    console.error('Server startup error:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  await pool.end();
  await redis.quit();
  process.exit(0);
});

startServer();

module.exports = app;

