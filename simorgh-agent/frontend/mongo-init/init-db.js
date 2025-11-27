// MongoDB Initialization Script for Simorgh Chatbot
// This script creates the necessary collections and indexes

db = db.getSiblingDB('simorgh');

// Create collections
db.createCollection('users');
db.createCollection('projects');
db.createCollection('chats');
db.createCollection('messages');
db.createCollection('conversations');
db.createCollection('documents');

print('Collections created successfully');

// ============================================
// Users Collection
// ============================================
db.users.createIndex({ email: 1 }, { unique: true });
db.users.createIndex({ userId: 1 }, { unique: true });
db.users.createIndex({ createdAt: -1 });

print('Users indexes created');

// ============================================
// Projects Collection
// ============================================
db.projects.createIndex({ projectId: 1 }, { unique: true });
db.projects.createIndex({ userId: 1 });
db.projects.createIndex({ createdAt: -1 });
db.projects.createIndex({ 'pid': 1, 'oeNumber': 1 });

print('Projects indexes created');

// ============================================
// Chats Collection
// ============================================
db.chats.createIndex({ chatId: 1 }, { unique: true });
db.chats.createIndex({ projectId: 1 });
db.chats.createIndex({ userId: 1 });
db.chats.createIndex({ isGeneral: 1 });
db.chats.createIndex({ updatedAt: -1 });
db.chats.createIndex({ createdAt: -1 });

print('Chats indexes created');

// ============================================
// Messages Collection
// ============================================
db.messages.createIndex({ messageId: 1 }, { unique: true });
db.messages.createIndex({ chatId: 1, createdAt: 1 });
db.messages.createIndex({ userId: 1, createdAt: -1 });
db.messages.createIndex({ projectId: 1 });
db.messages.createIndex({ role: 1 });

// Text search index for message content
db.messages.createIndex({ content: 'text' });

print('Messages indexes created');

// ============================================
// Conversations Collection (Multi-document)
// ============================================
db.conversations.createIndex({ conversationId: 1 }, { unique: true });
db.conversations.createIndex({ projectId: 1, oeNumber: 1 });
db.conversations.createIndex({ userId: 1 });
db.conversations.createIndex({ createdAt: -1 });
db.conversations.createIndex({ status: 1 });

print('Conversations indexes created');

// ============================================
// Documents Collection
// ============================================
db.documents.createIndex({ documentId: 1 }, { unique: true });
db.documents.createIndex({ conversationId: 1 });
db.documents.createIndex({ projectId: 1 });
db.documents.createIndex({ hash: 1 });
db.documents.createIndex({ uploadedAt: -1 });

print('Documents indexes created');

// ============================================
// Create sample admin user (optional)
// ============================================
db.users.insertOne({
  userId: 'admin',
  email: 'admin@simorgh.local',
  name: 'Admin User',
  role: 'admin',
  createdAt: new Date(),
  updatedAt: new Date(),
  isActive: true,
  preferences: {
    theme: 'cosmic',
    language: 'en',
    aiMode: 'online'
  }
});

print('Sample admin user created');

// ============================================
// Create sample general chat
// ============================================
const adminUser = db.users.findOne({ userId: 'admin' });
const sampleChatId = 'general_' + Date.now();

db.chats.insertOne({
  chatId: sampleChatId,
  userId: adminUser.userId,
  projectId: null,
  title: 'Welcome Chat',
  isGeneral: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  messageCount: 1
});

db.messages.insertOne({
  messageId: 'msg_' + Date.now(),
  chatId: sampleChatId,
  userId: 'system',
  projectId: null,
  role: 'assistant',
  content: 'Welcome to Simorgh AI Assistant! How can I help you today?',
  createdAt: new Date(),
  metadata: {
    isWelcome: true
  }
});

print('Sample chat created');

print('✅ MongoDB initialization complete!');
print('Database: simorgh');
print('Collections: users, projects, chats, messages, conversations, documents');