const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { VM } = require('vm2');
const cors = require('cors');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: process.env.NODE_ENV === 'production' 
            ? process.env.FRONTEND_URL 
            : "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Store active connections
const connections = new Map();

// Ensure auth directory exists
const authDir = path.join(__dirname, 'auth');
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

// Clean old auth files periodically
setInterval(() => {
    const now = Date.now();
    const files = fs.readdirSync(authDir);
    
    files.forEach(file => {
        const filePath = path.join(authDir, file);
        const stats = fs.statSync(filePath);
        const hoursDiff = (now - stats.mtimeMs) / (1000 * 60 * 60);
        
        // Delete auth files older than 24 hours
        if (hoursDiff > 24) {
            fs.rmSync(filePath, { recursive: true, force: true });
            console.log(`🧹 Deleted old auth: ${file}`);
        }
    });
}, 60 * 60 * 1000); // Check every hour

// Socket.IO connection
io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        time: new Date().toISOString(),
        connections: connections.size
    });
});

// Pairing endpoint
app.post('/api/pairing', async (req, res) => {
    const { phone } = req.body;
    const socketId = req.headers['x-socket-id'];
    
    try {
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        
        if (cleanPhone.length < 10 || cleanPhone.length > 15) {
            return res.status(400).json({ 
                success: false, 
                error: 'Nomor tidak valid' 
            });
        }

        console.log(`📱 Pairing request: ${cleanPhone}`);

        // Check if already connected
        if (connections.has(cleanPhone)) {
            const existing = connections.get(cleanPhone);
            if (existing.status === 'connected') {
                return res.json({ 
                    success: true, 
                    message: 'Already connected',
                    phone: cleanPhone
                });
            }
        }

        const authFolder = path.join(authDir, cleanPhone);
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            generateHighQualityLinkPreview: false,
            shouldSyncHistoryMessage: () => false
        });

        connections.set(cleanPhone, {
            sock,
            saveCreds,
            status: 'connecting',
            socketId,
            createdAt: Date.now()
        });

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`✅ Connected: ${cleanPhone}`);
                
                connections.set(cleanPhone, {
                    ...connections.get(cleanPhone),
                    status: 'connected'
                });

                io.to(socketId).emit('status', {
                    status: 'connected',
                    deviceInfo: {
                        phone: cleanPhone,
                        device: 'WhatsApp Web',
                        platform: 'Baileys'
                    }
                });

                // Request pairing code
                try {
                    const pairingCode = await sock.requestPairingCode(cleanPhone);
                    io.to(socketId).emit('pairing_code', { 
                        code: pairingCode.match(/.{1,4}/g).join('-') 
                    });
                } catch (err) {
                    console.log('QR fallback:', err.message);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                connections.set(cleanPhone, {
                    ...connections.get(cleanPhone),
                    status: 'disconnected'
                });

                io.to(socketId).emit('status', {
                    status: 'disconnected',
                    reason: lastDisconnect?.error?.message
                });

                console.log(`❌ Disconnected: ${cleanPhone}`);
                
                // Clean up after 5 minutes
                setTimeout(() => {
                    if (connections.has(cleanPhone) && 
                        connections.get(cleanPhone).status === 'disconnected') {
                        connections.delete(cleanPhone);
                    }
                }, 5 * 60 * 1000);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        res.json({ 
            success: true, 
            message: 'Pairing initiated',
            phone: cleanPhone
        });

    } catch (error) {
        console.error('Pairing error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Execute function endpoint
app.post('/api/execute', async (req, res) => {
    const { phone, target, code, loop = 1, delay = 1000 } = req.body;
    const socketId = req.headers['x-socket-id'];

    try {
        const connection = connections.get(phone);
        
        if (!connection || connection.status !== 'connected') {
            return res.status(400).json({ 
                success: false, 
                error: 'WhatsApp tidak terhubung' 
            });
        }

        const sock = connection.sock;
        const jid = target.includes('@s.whatsapp.net') ? target : `${target}@s.whatsapp.net`;

        // Validate function format
        if (!code.includes('async function') || !code.includes('sock, target')) {
            return res.status(400).json({ 
                success: false, 
                error: 'Format: async function nama(sock, target)' 
            });
        }

        const fnMatch = code.match(/async function\s+(\w+)/);
        if (!fnMatch) {
            return res.status(400).json({ 
                success: false, 
                error: 'Nama function tidak ditemukan' 
            });
        }

        const fnName = fnMatch[1];

        // Sandbox dengan fungsi WhatsApp yang aman
        const vm = new VM({
            timeout: 30000,
            sandbox: {
                sock: {
                    sendText: async (to, text) => {
                        try {
                            const result = await sock.sendMessage(to, { text });
                            return { success: true, id: result.key.id };
                        } catch (err) {
                            throw new Error(`Gagal kirim: ${err.message}`);
                        }
                    },
                    sendMessage: async (to, msg) => {
                        try {
                            const result = await sock.sendMessage(to, msg);
                            return { success: true, id: result.key.id };
                        } catch (err) {
                            throw new Error(`Gagal kirim: ${err.message}`);
                        }
                    },
                    sendImage: async (to, url, caption) => {
                        try {
                            const result = await sock.sendMessage(to, {
                                image: { url },
                                caption: caption || ''
                            });
                            return { success: true, id: result.key.id };
                        } catch (err) {
                            throw new Error(`Gagal kirim gambar: ${err.message}`);
                        }
                    },
                    sendVideo: async (to, url, caption) => {
                        try {
                            const result = await sock.sendMessage(to, {
                                video: { url },
                                caption: caption || ''
                            });
                            return { success: true, id: result.key.id };
                        } catch (err) {
                            throw new Error(`Gagal kirim video: ${err.message}`);
                        }
                    },
                    sendAudio: async (to, url) => {
                        try {
                            const result = await sock.sendMessage(to, {
                                audio: { url }
                            });
                            return { success: true, id: result.key.id };
                        } catch (err) {
                            throw new Error(`Gagal kirim audio: ${err.message}`);
                        }
                    },
                    sendContact: async (to, name, number) => {
                        try {
                            const vcard = 'BEGIN:VCARD\n' +
                                        'VERSION:3.0\n' +
                                        `FN:${name}\n` +
                                        `TEL;type=CELL;waid=${number}:${number}\n` +
                                        'END:VCARD';
                            
                            const result = await sock.sendMessage(to, {
                                contacts: {
                                    displayName: name,
                                    contacts: [{ vcard }]
                                }
                            });
                            return { success: true, id: result.key.id };
                        } catch (err) {
                            throw new Error(`Gagal kirim kontak: ${err.message}`);
                        }
                    },
                    sendLocation: async (to, lat, lng, name) => {
                        try {
                            const result = await sock.sendMessage(to, {
                                location: { 
                                    degreesLatitude: lat, 
                                    degreesLongitude: lng 
                                },
                                caption: name || ''
                            });
                            return { success: true, id: result.key.id };
                        } catch (err) {
                            throw new Error(`Gagal kirim lokasi: ${err.message}`);
                        }
                    },
                    sendPoll: async (to, question, options) => {
                        try {
                            const result = await sock.sendMessage(to, {
                                poll: {
                                    name: question,
                                    values: options
                                }
                            });
                            return { success: true, id: result.key.id };
                        } catch (err) {
                            throw new Error(`Gagal kirim poll: ${err.message}`);
                        }
                    },
                    react: async (to, messageId, emoji) => {
                        try {
                            const result = await sock.sendMessage(to, {
                                react: {
                                    text: emoji,
                                    key: { id: messageId }
                                }
                            });
                            return { success: true };
                        } catch (err) {
                            throw new Error(`Gagal react: ${err.message}`);
                        }
                    },
                    deleteMessage: async (to, messageId) => {
                        try {
                            const result = await sock.sendMessage(to, {
                                delete: { id: messageId }
                            });
                            return { success: true };
                        } catch (err) {
                            throw new Error(`Gagal hapus: ${err.message}`);
                        }
                    },
                    getUserStatus: async (jid) => {
                        try {
                            const status = await sock.fetchStatus(jid);
                            return status || { status: 'unknown' };
                        } catch (err) {
                            return { status: 'unknown' };
                        }
                    }
                },
                target: jid,
                console: {
                    log: (...args) => {
                        io.to(socketId).emit('console', { 
                            message: args.join(' ')
                        });
                    }
                },
                Buffer: Buffer,
                setTimeout: setTimeout,
                Date: Date,
                Math: Math,
                JSON: JSON
            }
        });

        const results = [];

        for (let i = 1; i <= loop; i++) {
            try {
                io.to(socketId).emit('progress', { 
                    current: i, 
                    total: loop
                });

                const startTime = Date.now();
                
                const result = await vm.run(`
                    ${code}
                    (async () => {
                        try {
                            return await ${fnName}(sock, target);
                        } catch (err) {
                            throw new Error(err.message);
                        }
                    })();
                `);

                const execTime = Date.now() - startTime;

                results.push({
                    loop: i,
                    success: true,
                    time: execTime
                });

                io.to(socketId).emit('result', {
                    loop: i,
                    success: true,
                    result: JSON.stringify(result).substring(0, 200),
                    time: execTime
                });

            } catch (err) {
                results.push({
                    loop: i,
                    success: false,
                    error: err.message
                });

                io.to(socketId).emit('result', {
                    loop: i,
                    success: false,
                    error: err.message
                });
            }

            if (i < loop) {
                await new Promise(r => setTimeout(r, delay));
            }
        }

        res.json({
            success: true,
            results
        });

    } catch (error) {
        console.error('Execute error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Disconnect endpoint
app.post('/api/disconnect', async (req, res) => {
    const { phone } = req.body;
    
    try {
        const connection = connections.get(phone);
        if (connection && connection.sock) {
            connection.sock.end();
            connections.delete(phone);
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get all connections
app.get('/api/connections', (req, res) => {
    const conns = Array.from(connections.entries()).map(([phone, data]) => ({
        phone,
        status: data.status,
        createdAt: data.createdAt
    }));
    
    res.json({ connections: conns });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Open http://localhost:${PORT}`);
});