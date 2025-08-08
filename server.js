const express = require('express');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    message: 'WhatsApp Chatbot Server is running!',
    timestamp: new Date().toISOString()
  });
});

// WhatsApp webhook verification (for Meta/Facebook)
app.get('/webhook', (req, res) => {
  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'your_verify_token_here';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === verifyToken) {
      console.log('✅ Webhook verified successfully!');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Webhook verification failed');
      res.sendStatus(403);
    }
  }
});

// WhatsApp webhook to receive messages
app.post('/webhook', (req, res) => {
  console.log('📨 Received webhook:', JSON.stringify(req.body, null, 2));
  
  const body = req.body;

  // Check if it's a WhatsApp message
  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
      const messages = body.entry[0].changes[0].value.messages;
      
      messages.forEach(message => {
        console.log('📱 Message received:', {
          from: message.from,
          text: message.text?.body || 'Non-text message',
          timestamp: message.timestamp
        });
        
        // Here's where you'll process the message and send a response
        processMessage(message, body.entry[0].changes[0].value);
      });
    }
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// Simple message processing function
async function processMessage(message, messageData) {
  const userMessage = message.text?.body;
  const phoneNumber = message.from;
  
  if (!userMessage) {
    console.log('⚠️ Received non-text message, skipping...');
    return;
  }

  console.log(`💬 Processing message from ${phoneNumber}: "${userMessage}"`);

  // Simple response logic (you can expand this)
  let botResponse = generateResponse(userMessage);

  // Send response back
  await sendWhatsAppMessage(phoneNumber, botResponse);
}

// Simple response generator (no AI, just basic responses)
function generateResponse(userMessage) {
  const message = userMessage.toLowerCase();
  
  // Simple response patterns
  if (message.includes('hello') || message.includes('hi')) {
    return "Hello! 👋 How can I help you today?";
  } else if (message.includes('help')) {
    return "I'm a simple chatbot! You can:\n• Say hello\n• Ask for help\n• Tell me about yourself\n• Say goodbye";
  } else if (message.includes('bye') || message.includes('goodbye')) {
    return "Goodbye! Have a great day! 👋";
  } else if (message.includes('how are you')) {
    return "I'm doing great! Thanks for asking. How are you?";
  } else if (message.includes('thank')) {
    return "You're welcome! Happy to help! 😊";
  } else {
    return `I received your message: "${userMessage}"\n\nI'm a simple bot right now. Try saying "help" to see what I can do!`;
  }
}

// Function to send WhatsApp message back
async function sendWhatsAppMessage(phoneNumber, message) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  
  if (!accessToken || !phoneNumberId) {
    console.log('⚠️ WhatsApp credentials not configured. Message would be:', message);
    return;
  }

  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;
  
  const data = {
    messaging_product: "whatsapp",
    to: phoneNumber,
    text: { body: message }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    if (response.ok) {
      console.log('✅ Message sent successfully');
    } else {
      console.log('❌ Failed to send message:', await response.text());
    }
  } catch (error) {
    console.error('❌ Error sending message:', error);
  }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 WhatsApp Chatbot Server started!');
  console.log(`📡 Server running on port ${PORT}`);
  console.log('📋 Environment variables needed:');
  console.log('   - WEBHOOK_VERIFY_TOKEN:', process.env.WEBHOOK_VERIFY_TOKEN ? '✅ Set' : '❌ Not set');
  console.log('   - WHATSAPP_ACCESS_TOKEN:', process.env.WHATSAPP_ACCESS_TOKEN ? '✅ Set' : '❌ Not set');
  console.log('   - WHATSAPP_PHONE_NUMBER_ID:', process.env.WHATSAPP_PHONE_NUMBER_ID ? '✅ Set' : '❌ Not set');
  console.log('');
  console.log('🔗 Webhook URL: https://your-railway-url.railway.app/webhook');
});

module.exports = app;
