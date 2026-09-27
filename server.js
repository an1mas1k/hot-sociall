const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse: parseUrl } = require('url');

const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');
const POSTS_FILE = path.join(__dirname, 'posts.json');
const DM_FILE = path.join(__dirname, 'dm.json');
const CHANNELS_FILE = path.join(__dirname, 'channels.json');
const CHATS_FILE = path.join(__dirname, 'chats.json');

const MAX_BODY_SIZE = 14 * 1024 * 1024;
const POSTS_PER_WALL = 100;
const FEED_LIMIT = 100;
const DM_HISTORY_LIMIT = 300;
const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/;

/* ---------- Автоматическое создание файлов базы данных ---------- */
function ensureFile(filePath) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '[]', 'utf8');
    }
}
[USERS_FILE, POSTS_FILE, DM_FILE, CHANNELS_FILE, CHATS_FILE].forEach(ensureFile);

function readUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]'); }
    catch (e) { return []; }
}
function saveUsers(users) { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8'); }

function readPosts() {
    try { return JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8') || '[]'); }
    catch (e) { return []; }
}
function savePosts(posts) { fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2), 'utf8'); }

function readDms() {
    try { return JSON.parse(fs.readFileSync(DM_FILE, 'utf8') || '[]'); }
    catch (e) { return []; }
}
function saveDms(dms) { fs.writeFileSync(DM_FILE, JSON.stringify(dms, null, 2), 'utf8'); }

function readChannels() {
    try { return JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8') || '[]'); }
    catch (e) { return []; }
}
function saveChannels(channels) { fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), 'utf8'); }

function readChats() {
    try { return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8') || '[]'); }
    catch (e) { return []; }
}
function saveChats(chats) { fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2), 'utf8'); }

function normalizeHandle(raw) { return (raw || '').trim().replace(/^@+/, ''); }
function dmKey(a, b) { return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('::'); }
function makeId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function hashPassword(password, salt) { return crypto.createHash('sha256').update(salt + ':' + password).digest('hex'); }
function generateSalt() { return crypto.randomBytes(16).toString('hex'); }

function sendJSON(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
    });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise(function (resolve, reject) {
        let body = '';
        req.on('data', function (chunk) {
            body += chunk;
            if (body.length > MAX_BODY_SIZE) { reject(new Error('Слишком большой запрос')); req.destroy(); }
        });
        req.on('end', function () {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (e) { reject(new Error('Некорректный JSON')); }
        });
        req.on('error', reject);
    });
}

/* ---------- 1. ОБНОВЛЕНИЕ ПРОФИЛЯ С КАСКАДНЫМ ИЗМЕНЕНИЕМ ---------- */
async function handleUpdateProfile(req, res) {
    try {
        const data = await readBody(req);
        const currentUsername = (data.currentUsername || '').trim();
        const newUsername = (data.newUsername || '').trim();
        const hasAvatar = Object.prototype.hasOwnProperty.call(data, 'avatar');
        const avatar = data.avatar;
        const hasHandle = Object.prototype.hasOwnProperty.call(data, 'handle');
        const handle = hasHandle ? normalizeHandle(typeof data.handle === 'string' ? data.handle : '') : null;

        if (!currentUsername) return sendJSON(res, 400, { error: 'Не указан текущий пользователь' });
        if (newUsername.length < 3 || newUsername.length > 20) return sendJSON(res, 400, { error: 'Ник — от 3 до 20 символов' });
        if (hasAvatar && typeof avatar === 'string' && avatar.length > MAX_BODY_SIZE) return sendJSON(res, 400, { error: 'Аватар слишком большой' });
        if (hasHandle && handle && !HANDLE_RE.test(handle)) return sendJSON(res, 400, { error: 'Юзернейм: 3-20 символов, латиница, цифры и _' });

        const users = readUsers();
        let user = users.find(u => u.username.toLowerCase() === currentUsername.toLowerCase());
        if (!user) return sendJSON(res, 404, { error: 'Пользователь не найден' });

        const lowerNewName = newUsername.toLowerCase();
        const lowerOldName = user.username.toLowerCase();
        const usernameChanged = lowerNewName !== lowerOldName;
        const avatarChanged = hasAvatar && avatar !== user.avatar;

        if (usernameChanged && users.some(u => u !== user && u.username.toLowerCase() === lowerNewName)) {
            return sendJSON(res, 409, { error: 'Такое имя уже занято' });
        }
        if (hasHandle && handle && users.some(u => u !== user && (u.handle || '').toLowerCase() === handle.toLowerCase())) {
            return sendJSON(res, 409, { error: 'Такой юзернейм уже занят' });
        }

        user.username = newUsername;
        if (hasAvatar) user.avatar = typeof avatar === 'string' ? avatar : '';
        if (hasHandle) user.handle = handle;

        // Каскадное обновление друзей и заявок в друзья при смене ника
        if (usernameChanged) {
            users.forEach(u => {
                if (Array.isArray(u.friends)) {
                    u.friends = u.friends.map(f => f.toLowerCase() === lowerOldName ? newUsername : f);
                }
                if (Array.isArray(u.incomingRequests)) {
                    u.incomingRequests = u.incomingRequests.map(r => r.toLowerCase() === lowerOldName ? newUsername : r);
                }
            });
        }
        saveUsers(users);

        if (usernameChanged || avatarChanged) {
            if (usernameChanged) {
                const dms = readDms();
                let dmsChanged = false;
                dms.forEach(m => {
                    if (m.from.toLowerCase() === lowerOldName) { m.from = newUsername; dmsChanged = true; }
                    if (m.to.toLowerCase() === lowerOldName) { m.to = newUsername; dmsChanged = true; }
                });
                if (dmsChanged) saveDms(dms);
            }

            const posts = readPosts();
            let postsChanged = false;
            posts.forEach(p => {
                if (p.username.toLowerCase() === lowerOldName) {
                    p.username = newUsername;
                    if (avatarChanged) p.avatar = user.avatar;
                    postsChanged = true;
                }
                if (p.repostOf && p.repostOf.username && p.repostOf.username.toLowerCase() === lowerOldName) {
                    p.repostOf.username = newUsername;
                    if (avatarChanged) p.repostOf.avatar = user.avatar;
                    postsChanged = true;
                }
                if (Array.isArray(p.likes)) {
                    const lIdx = p.likes.findIndex(l => l.toLowerCase() === lowerOldName);
                    if (lIdx !== -1) { p.likes[lIdx] = newUsername; postsChanged = true; }
                }
                if (Array.isArray(p.comments)) {
                    p.comments.forEach(c => {
                        if (c.username.toLowerCase() === lowerOldName) {
                            c.username = newUsername;
                            if (avatarChanged) c.avatar = user.avatar;
                            postsChanged = true;
                        }
                    });
                }
            });
            if (postsChanged) savePosts(posts);

            const channels = readChannels();
            let channelsChanged = false;
            channels.forEach(ch => {
                if (ch.owner.toLowerCase() === lowerOldName) { ch.owner = newUsername; channelsChanged = true; }
                if (Array.isArray(ch.members)) {
                    const mIdx = ch.members.findIndex(m => m.toLowerCase() === lowerOldName);
                    if (mIdx !== -1) { ch.members[mIdx] = newUsername; channelsChanged = true; }
                }
            });
            if (channelsChanged) saveChannels(channels);

            const chats = readChats();
            let chatsChanged = false;
            chats.forEach(ch => {
                if (ch.owner.toLowerCase() === lowerOldName) { ch.owner = newUsername; chatsChanged = true; }
                if (Array.isArray(ch.members)) {
                    const mIdx = ch.members.findIndex(m => m.toLowerCase() === lowerOldName);
                    if (mIdx !== -1) { ch.members[mIdx] = newUsername; chatsChanged = true; }
                }
                if (Array.isArray(ch.messages)) {
                    ch.messages.forEach(msg => {
                        if (msg.from.toLowerCase() === lowerOldName) { msg.from = newUsername; chatsChanged = true; }
                    });
                }
            });
            if (chatsChanged) saveChats(chats);
        }

        sendJSON(res, 200, {
            oldUsername: currentUsername,
            username: user.username,
            email: user.email,
            avatar: user.avatar || '',
            handle: user.handle || '',
            friends: user.friends || []
        });
    } catch (e) {
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

/* ---------- 2. ДРУЗЬЯ И ЗАЯВКИ В ДРУЗЬЯ ---------- */
async function handleFriendAction(req, res) {
    try {
        const data = await readBody(req);
        const me = (data.me || '').trim();
        const target = (data.target || '').trim();
        const action = (data.action || '').trim(); // 'send', 'accept', 'decline', 'cancel', 'remove'

        if (!me || !target || !action) return sendJSON(res, 400, { error: 'Недостаточно данных' });
        if (me.toLowerCase() === target.toLowerCase()) return sendJSON(res, 400, { error: 'Нельзя выполнить действие с собой' });

        const users = readUsers();
        const meUser = users.find(u => u.username.toLowerCase() === me.toLowerCase());
        const targetUser = users.find(u => u.username.toLowerCase() === target.toLowerCase());

        if (!meUser || !targetUser) return sendJSON(res, 404, { error: 'Пользователь не найден' });

        if (!Array.isArray(meUser.friends)) meUser.friends = [];
        if (!Array.isArray(targetUser.friends)) targetUser.friends = [];
        if (!Array.isArray(meUser.incomingRequests)) meUser.incomingRequests = [];
        if (!Array.isArray(targetUser.incomingRequests)) targetUser.incomingRequests = [];

        const lowerMe = meUser.username.toLowerCase();
        const lowerTarget = targetUser.username.toLowerCase();

        if (action === 'send') {
            // Отправить заявку в друзья
            if (!targetUser.incomingRequests.some(r => r.toLowerCase() === lowerMe)) {
                targetUser.incomingRequests.push(meUser.username);
            }
        } else if (action === 'cancel') {
            // Отменить отправленную заявку
            targetUser.incomingRequests = targetUser.incomingRequests.filter(r => r.toLowerCase() !== lowerMe);
        } else if (action === 'accept') {
            // Принять входящую заявку
            meUser.incomingRequests = meUser.incomingRequests.filter(r => r.toLowerCase() !== lowerTarget);
            if (!meUser.friends.some(f => f.toLowerCase() === lowerTarget)) meUser.friends.push(targetUser.username);
            if (!targetUser.friends.some(f => f.toLowerCase() === lowerMe)) targetUser.friends.push(meUser.username);
        } else if (action === 'decline') {
            // Отклонить входящую заявку
            meUser.incomingRequests = meUser.incomingRequests.filter(r => r.toLowerCase() !== lowerTarget);
        } else if (action === 'remove') {
            // Удалить из друзей
            meUser.friends = meUser.friends.filter(f => f.toLowerCase() !== lowerTarget);
            targetUser.friends = targetUser.friends.filter(f => f.toLowerCase() !== lowerMe);
        }

        saveUsers(users);
        sendJSON(res, 200, { ok: true, meFriends: meUser.friends, incomingCount: meUser.incomingRequests.length });
    } catch (e) {
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

function handleFriendStatus(req, res, query) {
    const me = (query.me || '').trim().toLowerCase();
    const target = (query.target || '').trim().toLowerCase();
    const users = readUsers();
    const meUser = users.find(u => u.username.toLowerCase() === me);
    const targetUser = users.find(u => u.username.toLowerCase() === target);

    if (!meUser || !targetUser) return sendJSON(res, 404, { error: 'Пользователь не найден' });

    const isFriends = (meUser.friends || []).some(f => f.toLowerCase() === target);
    const isSent = (targetUser.incomingRequests || []).some(r => r.toLowerCase() === me);
    const isReceived = (meUser.incomingRequests || []).some(r => r.toLowerCase() === target);

    let status = 'none';
    if (isFriends) status = 'friends';
    else if (isReceived) status = 'received';
    else if (isSent) status = 'sent';

    sendJSON(res, 200, { status: status });
}

function handleFriendsGet(req, res, query) {
    const username = (query.username || '').trim().toLowerCase();
    const users = readUsers();
    const user = users.find(u => u.username.toLowerCase() === username);
    if (!user) return sendJSON(res, 404, { error: 'Пользователь не найден' });

    const friendNames = Array.isArray(user.friends) ? user.friends : [];
    const friends = users
        .filter(u => friendNames.some(fn => fn.toLowerCase() === u.username.toLowerCase()))
        .map(u => ({ username: u.username, avatar: u.avatar || '', handle: u.handle || '' }));

    const reqNames = Array.isArray(user.incomingRequests) ? user.incomingRequests : [];
    const requests = users
        .filter(u => reqNames.some(rn => rn.toLowerCase() === u.username.toLowerCase()))
        .map(u => ({ username: u.username, avatar: u.avatar || '', handle: u.handle || '' }));

    sendJSON(res, 200, { friends: friends, requests: requests });
}

/* ---------- 3. КАНАЛЫ (НАСТРОЙКИ, СООБЩЕНИЯ ОТ КАНАЛА, РЕАКЦИИ) ---------- */
function channelPublic(c, viewer) {
    const isSub = viewer ? (c.members || []).some(m => m.toLowerCase() === viewer.toLowerCase()) : false;
    return {
        id: c.id,
        username: c.username,
        name: c.name,
        description: c.description || '',
        avatar: c.avatar || '',
        owner: c.owner,
        createdAt: c.createdAt,
        members: Array.isArray(c.members) ? c.members.length : 0,
        isSubscribed: isSub
    };
}

async function handleChannelCreate(req, res) {
    try {
        const data = await readBody(req);
        const owner = (data.owner || '').trim();
        const name = (data.name || '').trim();
        const username = normalizeHandle(data.username || '');
        if (!name || !username) return sendJSON(res, 400, { error: 'Заполните название и юзернейм канала' });
        if (!HANDLE_RE.test(username)) return sendJSON(res, 400, { error: 'Юзернейм: 3-20 символов (латиница, цифры, _)' });

        const channels = readChannels();
        if (channels.some(c => c.username.toLowerCase() === username.toLowerCase())) return sendJSON(res, 409, { error: 'Юзернейм канала занят' });
        const channel = {
            id: makeId(),
            username: username,
            name: name,
            description: (data.description || '').trim(),
            avatar: data.avatar || '',
            owner: owner,
            members: [owner],
            messages: [],
            createdAt: new Date().toISOString()
        };
        channels.push(channel);
        saveChannels(channels);
        sendJSON(res, 201, { channel: channelPublic(channel, owner) });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

async function handleChannelUpdate(req, res) {
    try {
        const data = await readBody(req);
        const originalUsername = normalizeHandle(data.originalUsername || '');
        const owner = (data.owner || '').trim();
        const newName = (data.name || '').trim();
        const newUsername = normalizeHandle(data.username || '');
        const description = (data.description || '').trim();
        const avatar = typeof data.avatar === 'string' ? data.avatar : null;

        if (!originalUsername || !newName || !newUsername) return sendJSON(res, 400, { error: 'Заполните все поля' });
        if (!HANDLE_RE.test(newUsername)) return sendJSON(res, 400, { error: 'Юзернейм: 3-20 символов (латиница, цифры, _)' });

        const channels = readChannels();
        const ch = channels.find(c => c.username.toLowerCase() === originalUsername.toLowerCase());
        if (!ch) return sendJSON(res, 404, { error: 'Канал не найден' });
        if (ch.owner.toLowerCase() !== owner.toLowerCase()) return sendJSON(res, 403, { error: 'Только владелец может менять настройки' });

        if (newUsername.toLowerCase() !== originalUsername.toLowerCase() && channels.some(c => c.username.toLowerCase() === newUsername.toLowerCase())) {
            return sendJSON(res, 409, { error: 'Этот юзернейм канала уже занят' });
        }

        ch.name = newName;
        ch.username = newUsername;
        ch.description = description;
        if (avatar !== null) ch.avatar = avatar;

        saveChannels(channels);
        sendJSON(res, 200, { channel: channelPublic(ch, owner) });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

async function handleChannelSubscribe(req, res) {
    try {
        const data = await readBody(req);
        const channelUsername = normalizeHandle(data.channel || '');
        const username = (data.username || '').trim();
        if (!channelUsername || !username) return sendJSON(res, 400, { error: 'Не хватает данных' });

        const channels = readChannels();
        const ch = channels.find(c => c.username.toLowerCase() === channelUsername.toLowerCase());
        if (!ch) return sendJSON(res, 404, { error: 'Канал не найден' });

        if (!Array.isArray(ch.members)) ch.members = [];
        const lowerUser = username.toLowerCase();
        const idx = ch.members.findIndex(m => m.toLowerCase() === lowerUser);

        let subscribed = false;
        if (idx === -1) {
            ch.members.push(username);
            subscribed = true;
        } else {
            ch.members.splice(idx, 1);
            subscribed = false;
        }
        saveChannels(channels);
        sendJSON(res, 200, { subscribed: subscribed, memberCount: ch.members.length });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

function handleChannelGet(req, res, query) {
    const c = readChannels().find(x => x.username.toLowerCase() === normalizeHandle(query.username || '').toLowerCase());
    if (!c) return sendJSON(res, 404, { error: 'Канал не найден' });
    sendJSON(res, 200, { channel: channelPublic(c, query.viewer) });
}

function handleChannelSearch(req, res, query) {
    const q = normalizeHandle(query.q || '').toLowerCase();
    const channels = readChannels();
    const found = q ? channels.filter(c => c.username.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) : channels;
    sendJSON(res, 200, { channels: found.slice(0, 20).map(c => channelPublic(c, query.viewer)) });
}

function handleChannelMessagesGet(req, res, query) {
    const c = readChannels().find(x => x.username.toLowerCase() === normalizeHandle(query.username || '').toLowerCase());
    if (!c) return sendJSON(res, 404, { error: 'Канал не найден' });
    sendJSON(res, 200, { messages: (c.messages || []).slice(-300) });
}

async function handleChannelMessageCreate(req, res) {
    try {
        const data = await readBody(req);
        const channels = readChannels();
        const c = channels.find(x => x.username.toLowerCase() === normalizeHandle(data.channel || '').toLowerCase());
        if (!c) return sendJSON(res, 404, { error: 'Канал не найден' });
        if (c.owner.toLowerCase() !== (data.from || '').toLowerCase()) return sendJSON(res, 403, { error: 'Только владелец' });

        const msg = {
            id: makeId(),
            from: c.name,
            channelUsername: c.username,
            channelAvatar: c.avatar || '',
            text: data.text.trim(),
            reactions: { like: [], fire: [], demon: [] },
            createdAt: new Date().toISOString()
        };
        if (!Array.isArray(c.messages)) c.messages = [];
        c.messages.push(msg);
        saveChannels(channels);
        sendJSON(res, 201, { message: msg });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

async function handleChannelMessageReaction(req, res) {
    try {
        const data = await readBody(req);
        const channelUsername = normalizeHandle(data.channel || '');
        const messageId = (data.messageId || '').trim();
        const username = (data.username || '').trim();
        const reactionType = (data.type || '').trim();

        if (!['like', 'fire', 'demon'].includes(reactionType)) {
            return sendJSON(res, 400, { error: 'Неизвестный тип реакции' });
        }

        const channels = readChannels();
        const c = channels.find(x => x.username.toLowerCase() === channelUsername.toLowerCase());
        if (!c) return sendJSON(res, 404, { error: 'Канал не найден' });

        const msg = (c.messages || []).find(m => m.id === messageId);
        if (!msg) return sendJSON(res, 404, { error: 'Сообщение не найдено' });

        if (!msg.reactions) msg.reactions = { like: [], fire: [], demon: [] };
        if (!Array.isArray(msg.reactions[reactionType])) msg.reactions[reactionType] = [];

        const lowerUser = username.toLowerCase();
        const idx = msg.reactions[reactionType].findIndex(u => u.toLowerCase() === lowerUser);
        if (idx === -1) {
            msg.reactions[reactionType].push(username);
        } else {
            msg.reactions[reactionType].splice(idx, 1);
        }

        saveChannels(channels);
        sendJSON(res, 200, { reactions: msg.reactions });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

/* ---------- Аутентификация ---------- */
async function handleRegister(req, res) {
    try {
        const data = await readBody(req);
        const username = (data.username || '').trim();
        const email = (data.email || '').trim();
        const password = data.password || '';

        if (username.length < 3) return sendJSON(res, 400, { error: 'Имя — минимум 3 символа' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, 400, { error: 'Некорректный email' });
        if (password.length < 6) return sendJSON(res, 400, { error: 'Пароль — минимум 6 символов' });

        const users = readUsers();
        if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) return sendJSON(res, 409, { error: 'Такое имя уже занято' });
        if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) return sendJSON(res, 409, { error: 'Эта почта уже зарегистрирована' });

        const salt = generateSalt();
        const newUser = {
            username: username,
            email: email,
            salt: salt,
            passwordHash: hashPassword(password, salt),
            avatar: '',
            handle: '',
            friends: [],
            incomingRequests: [],
            createdAt: new Date().toISOString()
        };
        users.push(newUser);
        saveUsers(users);
        sendJSON(res, 201, { username: newUser.username, email: newUser.email, avatar: newUser.avatar, handle: newUser.handle, friends: [], incomingRequests: [] });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

async function handleLogin(req, res) {
    try {
        const data = await readBody(req);
        const login = (data.login || '').trim().toLowerCase();
        const password = data.password || '';
        if (!login || !password) return sendJSON(res, 400, { error: 'Введите логин и пароль' });

        const users = readUsers();
        const user = users.find(u => u.username.toLowerCase() === login || u.email.toLowerCase() === login);
        if (!user) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        if (hashPassword(password, user.salt) !== user.passwordHash) return sendJSON(res, 401, { error: 'Неверный пароль' });

        sendJSON(res, 200, {
            username: user.username,
            email: user.email,
            avatar: user.avatar || '',
            handle: user.handle || '',
            friends: user.friends || [],
            incomingRequests: user.incomingRequests || []
        });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

function handleUsersList(req, res) {
    const safe = readUsers().map(u => ({
        username: u.username,
        email: u.email,
        avatar: u.avatar || '',
        handle: u.handle || '',
        friends: u.friends || [],
        createdAt: u.createdAt
    }));
    sendJSON(res, 200, { users: safe });
}

function handleUserSearch(req, res, query) {
    const q = normalizeHandle(query.q || '').toLowerCase();
    const users = readUsers();
    let results = q ? users.filter(u => (u.handle || '').toLowerCase().includes(q) || u.username.toLowerCase().includes(q)) : users;
    sendJSON(res, 200, { users: results.slice(0, 20).map(u => ({ username: u.username, avatar: u.avatar || '', handle: u.handle || '' })) });
}

/* ---------- Посты, чаты, диалоги ---------- */
function normalizePost(p, repostedByViewer) {
    return {
        id: p.id,
        username: p.username,
        avatar: p.avatar || '',
        text: p.text || '',
        image: p.image || '',
        createdAt: p.createdAt,
        likes: Array.isArray(p.likes) ? p.likes : [],
        comments: Array.isArray(p.comments) ? p.comments : [],
        repostOf: p.repostOf || null,
        repostCount: typeof p.repostCount === 'number' ? p.repostCount : 0,
        repostedByViewer: !!repostedByViewer
    };
}

function handleFeedGet(req, res, query) {
    const viewer = (query.viewer || '').trim().toLowerCase();
    const allPosts = readPosts();
    const feedPosts = allPosts.filter(p => !p.repostOf);
    const viewerReposts = new Set();
    if (viewer) {
        allPosts.forEach(p => {
            if (p.username && p.username.toLowerCase() === viewer && p.repostOf && p.repostOf.id) viewerReposts.add(p.repostOf.id);
        });
    }
    const posts = feedPosts.map(p => normalizePost(p, viewerReposts.has(p.id)));
    posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    sendJSON(res, 200, { posts: posts.slice(0, FEED_LIMIT) });
}

function handlePostsGet(req, res, query) {
    const username = (query.username || '').trim();
    if (!username) return sendJSON(res, 400, { error: 'Не указан пользователь' });
    const allPosts = readPosts();
    const viewer = (query.viewer || '').trim().toLowerCase();
    const viewerReposts = new Set();
    if (viewer) {
        allPosts.forEach(p => {
            if (p.username && p.username.toLowerCase() === viewer && p.repostOf && p.repostOf.id) viewerReposts.add(p.repostOf.id);
        });
    }
    const posts = allPosts.map(p => normalizePost(p, viewerReposts.has(p.id) || (p.repostOf && viewerReposts.has(p.repostOf.id))));
    const filtered = posts.filter(p => p.username.toLowerCase() === username.toLowerCase());
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    sendJSON(res, 200, { posts: filtered.slice(0, POSTS_PER_WALL) });
}

async function handlePostsCreate(req, res) {
    try {
        const data = await readBody(req);
        const username = (data.username || '').trim();
        const text = (data.text || '').trim();
        const image = typeof data.image === 'string' ? data.image : '';

        if (!username) return sendJSON(res, 400, { error: 'Не указан автор' });
        if (!text && !image) return sendJSON(res, 400, { error: 'Пустой пост' });
        const users = readUsers();
        const author = users.find(u => u.username.toLowerCase() === username.toLowerCase());
        if (!author) return sendJSON(res, 404, { error: 'Пользователь не найден' });

        const post = {
            id: makeId(), username: author.username, avatar: author.avatar || '',
            text: text, image: image, createdAt: new Date().toISOString(),
            likes: [], comments: [], repostOf: null, repostCount: 0
        };
        const posts = readPosts();
        posts.push(post);
        savePosts(posts.length > 3000 ? posts.slice(-3000) : posts);
        sendJSON(res, 201, { post: normalizePost(post) });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

async function handlePostLike(req, res) {
    try {
        const data = await readBody(req);
        const id = (data.id || '').trim();
        const username = (data.username || '').trim();
        const posts = readPosts();
        const idx = posts.findIndex(p => p.id === id);
        if (idx === -1) return sendJSON(res, 404, { error: 'Пост не найден' });
        if (!Array.isArray(posts[idx].likes)) posts[idx].likes = [];
        const lower = username.toLowerCase();
        const uIdx = posts[idx].likes.findIndex(u => u.toLowerCase() === lower);
        if (uIdx === -1) posts[idx].likes.push(username);
        else posts[idx].likes.splice(uIdx, 1);
        savePosts(posts);
        sendJSON(res, 200, { likes: posts[idx].likes, liked: uIdx === -1 });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

async function handlePostComment(req, res) {
    try {
        const data = await readBody(req);
        const id = (data.id || '').trim();
        const username = (data.username || '').trim();
        const text = (data.text || '').trim();
        const author = readUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
        if (!author) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        const posts = readPosts();
        const idx = posts.findIndex(p => p.id === id);
        if (idx === -1) return sendJSON(res, 404, { error: 'Пост не найден' });
        if (!Array.isArray(posts[idx].comments)) posts[idx].comments = [];
        const comment = { id: makeId(), username: author.username, avatar: author.avatar || '', text: text, createdAt: new Date().toISOString() };
        posts[idx].comments.push(comment);
        savePosts(posts);
        sendJSON(res, 201, { comment: comment, comments: posts[idx].comments });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

function handleCommentsGet(req, res, query) {
    const post = readPosts().find(p => p.id === (query.id || '').trim());
    if (!post) return sendJSON(res, 404, { error: 'Пост не найден' });
    sendJSON(res, 200, { comments: Array.isArray(post.comments) ? post.comments : [] });
}

async function handlePostRepost(req, res) {
    try {
        const data = await readBody(req);
        const id = (data.id || '').trim();
        const username = (data.username || '').trim();
        const author = readUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
        if (!author) return sendJSON(res, 404, { error: 'Пользователь не найден' });
        const posts = readPosts();
        let target = posts.find(p => p.id === id);
        if (!target) return sendJSON(res, 404, { error: 'Пост не найден' });
        const originalId = target.repostOf && target.repostOf.id ? target.repostOf.id : target.id;
        const original = posts.find(p => p.id === originalId);
        if (!original) return sendJSON(res, 404, { error: 'Оригинал не найден' });

        let removed = 0;
        const kept = [];
        posts.forEach(p => {
            if (p.repostOf && p.repostOf.id === originalId && p.username && p.username.toLowerCase() === author.username.toLowerCase()) {
                removed++;
            } else kept.push(p);
        });

        if (removed > 0) {
            original.repostCount = Math.max(0, (original.repostCount || 0) - removed);
            savePosts(kept);
            return sendJSON(res, 200, { reposted: false, repostCount: original.repostCount });
        }
        const repost = {
            id: makeId(), username: author.username, avatar: author.avatar || '',
            text: '', image: '', createdAt: new Date().toISOString(), likes: [], comments: [],
            repostOf: { id: original.id, username: original.username, avatar: original.avatar || '', text: original.text || '', image: original.image || '', createdAt: original.createdAt },
            repostCount: 0
        };
        original.repostCount = (original.repostCount || 0) + 1;
        kept.push(repost);
        savePosts(kept);
        sendJSON(res, 201, { reposted: true, post: normalizePost(repost, true), repostCount: original.repostCount });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

async function handleChatCreate(req, res) {
    try {
        const data = await readBody(req);
        const owner = (data.owner || '').trim();
        const name = (data.name || '').trim();
        let members = Array.isArray(data.members) ? data.members : [];
        if (!members.some(x => x.toLowerCase() === owner.toLowerCase())) members.unshift(owner);
        const chat = { id: makeId(), name: name, owner: owner, members: members, messages: [], createdAt: new Date().toISOString() };
        const chats = readChats();
        chats.push(chat);
        saveChats(chats);
        sendJSON(res, 201, { chat: { id: chat.id, name: chat.name, owner: chat.owner, members: chat.members, memberCount: chat.members.length } });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

function handleChatsGet(req, res, query) {
    const user = (query.user || '').trim().toLowerCase();
    const list = readChats().filter(c => (c.members || []).some(m => m.toLowerCase() === user)).map(c => {
        const last = c.messages && c.messages.length ? c.messages[c.messages.length - 1] : null;
        return { id: c.id, name: c.name, owner: c.owner, members: c.members, memberCount: c.members.length, lastText: last ? last.text : '', lastAt: last ? last.createdAt : c.createdAt };
    });
    sendJSON(res, 200, { chats: list });
}

function handleChatMessagesGet(req, res, query) {
    const chat = readChats().find(x => x.id === (query.id || '').trim());
    if (!chat) return sendJSON(res, 404, { error: 'Чат не найден' });
    sendJSON(res, 200, { chat: { id: chat.id, name: chat.name, memberCount: chat.members.length }, messages: (chat.messages || []).slice(-300) });
}

async function handleChatMessageCreate(req, res) {
    try {
        const data = await readBody(req);
        const chats = readChats();
        const c = chats.find(x => x.id === data.id);
        if (!c) return sendJSON(res, 404, { error: 'Чат не найден' });
        const msg = { id: makeId(), from: data.from.trim(), text: data.text.trim(), createdAt: new Date().toISOString() };
        if (!Array.isArray(c.messages)) c.messages = [];
        c.messages.push(msg);
        saveChats(chats);
        sendJSON(res, 201, { message: msg });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

function handleDmGet(req, res, query) {
    const user = (query.user || '').trim();
    const withUser = (query.with || '').trim();
    const key = dmKey(user, withUser);
    const dms = readDms();
    let changed = false;
    dms.forEach(m => {
        if (dmKey(m.from, m.to) === key && m.to.toLowerCase() === user.toLowerCase() && !m.read) {
            m.read = true;
            changed = true;
        }
    });
    if (changed) saveDms(dms);
    const conv = dms.filter(m => dmKey(m.from, m.to) === key);
    sendJSON(res, 200, { messages: conv.slice(-DM_HISTORY_LIMIT) });
}

async function handleDmCreate(req, res) {
    try {
        const data = await readBody(req);
        const message = { id: makeId(), from: data.from.trim(), to: data.to.trim(), text: data.text.trim(), read: false, createdAt: new Date().toISOString() };
        const dms = readDms();
        dms.push(message);
        saveDms(dms.length > 5000 ? dms.slice(-5000) : dms);
        sendJSON(res, 201, { message: message });
    } catch (e) { sendJSON(res, 500, { error: 'Ошибка сервера' }); }
}

function handleDmConversations(req, res, query) {
    const user = (query.user || '').trim().toLowerCase();
    const dms = readDms();
    const users = readUsers();
    const map = {};
    dms.forEach(m => {
        const fromLower = m.from.toLowerCase();
        const toLower = m.to.toLowerCase();
        if (fromLower !== user && toLower !== user) return;
        const partnerName = fromLower === user ? m.to : m.from;
        const partnerLower = partnerName.toLowerCase();
        if (!map[partnerLower]) map[partnerLower] = { partnerUsername: partnerName, lastMessage: m, unread: 0 };
        if (new Date(m.createdAt) > new Date(map[partnerLower].lastMessage.createdAt)) map[partnerLower].lastMessage = m;
        if (toLower === user && !m.read) map[partnerLower].unread++;
    });
    const list = Object.keys(map).map(k => {
        const partner = users.find(u => u.username.toLowerCase() === k);
        return {
            username: partner ? partner.username : map[k].partnerUsername,
            avatar: partner ? partner.avatar : '',
            handle: partner ? partner.handle : '',
            lastText: map[k].lastMessage.text,
            lastFrom: map[k].lastMessage.from,
            lastAt: map[k].lastMessage.createdAt,
            unread: map[k].unread
        };
    }).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    sendJSON(res, 200, { conversations: list });
}

function handleDmUnreadCount(req, res, query) {
    const user = (query.user || '').trim().toLowerCase();
    const count = readDms().filter(m => m.to.toLowerCase() === user && !m.read).length;
    sendJSON(res, 200, { count: count });
}

/* =====================================================================
   ВСТРОЕННЫЙ HTML КЛИЕНТ
   ===================================================================== */
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hot — социальная сеть</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
    --bg-dark-1: #070a16; --bg-dark-2: #101126; --bg-dark-3: #090714;
    --accent-1: #ff24a8; --accent-2: #8e35ff; --accent-3: #ff38c6;
    --border: #30416c; --border-soft: rgba(255,255,255,0.05); --border-strong: #34466f;
    --text-primary: #fff; --text-secondary: #9da4c5; --text-muted: #8993b4;
    --input-bg: rgba(20,29,54,0.82);
    --card-bg-1: rgba(12,18,38,0.96); --card-bg-2: rgba(5,10,23,0.96);
    --radius-sm: 13px; --radius-md: 15px; --radius-lg: 17px; --radius-xl: 25px;
    --shadow-card: 0 0 70px rgba(0,0,0,0.45), 0 0 40px rgba(180,0,255,0.08);
    --shadow-button: 0 10px 30px rgba(207,28,220,0.28);
    --transition: 0.25s ease;
}
* { margin:0; padding:0; box-sizing:border-box; }
body {
    font-family: 'Inter', Arial, sans-serif; min-height: 100vh; color: var(--text-primary);
    background: radial-gradient(circle at 70% 30%, rgba(150,30,120,0.30), transparent 35%),
        linear-gradient(120deg, var(--bg-dark-1), var(--bg-dark-2) 50%, var(--bg-dark-3));
}
body::before {
    content:""; position:fixed; inset:0;
    background: radial-gradient(circle at 20% 70%, rgba(255,0,150,0.12), transparent 30%),
        radial-gradient(circle at 80% 20%, rgba(100,50,255,0.15), transparent 35%);
    pointer-events:none; z-index:0;
}
header {
    height:76px; width:100%; display:flex; align-items:center; padding:0 5%;
    background: rgba(5,8,20,0.88); border-bottom: 1px solid var(--border-soft);
    position:relative; z-index:10;
}
.logo { display:flex; align-items:center; font-size:30px; font-weight:700; margin-right:30px; cursor:pointer; text-decoration:none; }
.logo-fire { font-size:36px; margin-right:8px; filter: drop-shadow(0 0 8px #ff1cae); }
.logo-text { background: linear-gradient(90deg,#fff,#d8d8ff); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
nav { display:flex; gap:20px; }
nav a { color: var(--text-secondary); font-size:15px; cursor:pointer; text-decoration:none; transition: color var(--transition); display:flex; align-items:center; }
nav a:hover, nav a.active { color: var(--text-primary); font-weight:600; }
.header-right { margin-left:auto; display:flex; align-items:center; gap:14px; }

/* Поиск */
.search-container { position:relative; }
.search { width:220px; height:40px; border-radius:22px; background: rgba(25,30,55,0.8); display:flex; align-items:center; padding:0 15px; font-size:14px; color: var(--text-muted); border: 1px solid transparent; transition: border-color var(--transition); }
.search:focus-within { border-color: var(--accent-2); }
.search input { background:transparent; border:none; outline:none; color:var(--text-primary); font-size:14px; width:100%; font-family:inherit; }
.search-icon { font-size:17px; margin-right:8px; }
.global-search-dropdown {
    position:absolute; top:calc(100% + 8px); left:0; width:300px;
    background: linear-gradient(145deg, var(--card-bg-1), var(--card-bg-2));
    border: 1px solid var(--border-strong); border-radius: var(--radius-md);
    box-shadow: var(--shadow-card); z-index:100; max-height:360px; overflow-y:auto; padding:8px;
}
.global-search-item { display:flex; align-items:center; gap:10px; padding:9px; border-radius: var(--radius-sm); cursor:pointer; transition: background 0.2s; }
.global-search-item:hover { background: rgba(142,53,255,0.18); }
.exact-match-badge { margin-left:auto; font-size:10px; padding:3px 6px; background: var(--accent-1); color:#fff; border-radius:8px; font-weight:700; }

/* Кнопка смены языка */
.lang-btn { border: 1px solid #34406b; background: transparent; color: #c7cbe4; padding: 7px 12px; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; font-weight: 700; font-family: inherit; }
.lang-btn:hover { border-color: var(--accent-1); color: #fff; }

/* Мультиаккаунт */
.user-menu-wrapper { position:relative; }
.login-top { border:1px solid #34406b; background:transparent; color:#c7cbe4; padding:9px 20px; border-radius: var(--radius-sm); cursor:pointer; font-size:14px; font-family:inherit; }
.login-top:hover { border-color: var(--accent-1); color:#fff; }
.user-info { display:flex; align-items:center; gap:8px; cursor:pointer; padding:4px 8px; border-radius:30px; }
.user-info:hover { background: rgba(255,255,255,0.05); }
.user-avatar { width:38px; height:38px; border-radius:50%; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:16px; overflow:hidden; flex-shrink:0; }
.user-avatar img { width:100%; height:100%; object-fit:cover; }
.user-name { font-size:14px; font-weight:600; max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.account-arrow-btn { background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:11px; padding:4px; }
.account-arrow-btn:hover { color:#fff; }
.account-dropdown {
    position:absolute; top:calc(100% + 10px); right:0; width:260px;
    background: linear-gradient(145deg, var(--card-bg-1), var(--card-bg-2));
    border: 1px solid var(--border-strong); border-radius: var(--radius-md);
    box-shadow: var(--shadow-card); z-index:100; padding:8px;
}
.account-dropdown-item { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius: var(--radius-sm); cursor:pointer; }
.account-dropdown-item:hover { background: rgba(255,255,255,0.06); }
.account-dropdown-item.active { border-left: 3px solid var(--accent-1); background: rgba(255,36,168,0.08); }
.add-account-btn { width:100%; text-align:left; padding:10px; border:none; background:transparent; color:var(--accent-3); cursor:pointer; font-weight:600; border-top:1px solid var(--border-soft); margin-top:6px; font-family:inherit; font-size:13px; }

main { min-height: calc(100vh - 76px); padding:35px 6%; position:relative; z-index:1; }
.main-auth { display:flex; align-items:center; min-height: calc(100vh - 76px - 110px); }
.hero { width:48%; padding-left:4%; }
.hero-logo { display:flex; align-items:center; font-size:68px; font-weight:700; margin-bottom:12px; }
.hero-fire { font-size:80px; margin-right:16px; filter: drop-shadow(0 0 15px #ff20bb) drop-shadow(0 0 35px #8c20ff); }
.hero-title { background: linear-gradient(90deg,#fff,#c7bfff); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
.hero-subtitle { color:#9198b8; font-size:20px; letter-spacing:4px; margin-left:10px; }
.registration { width:580px; margin-left:auto; background: linear-gradient(145deg,var(--card-bg-1),var(--card-bg-2)); border:1px solid var(--border-strong); border-radius: var(--radius-xl); padding:45px 50px; box-shadow: var(--shadow-card); }
.registration h1 { font-size:42px; margin-bottom:10px; background: linear-gradient(90deg,#fff,#d890ff); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
.description { color:#9aa4c7; font-size:16px; margin-bottom:30px; }
.input { height:56px; width:100%; margin-bottom:15px; border-radius: var(--radius-md); border:1px solid var(--border); background: var(--input-bg); color:#fff; font-family:inherit; font-size:15px; padding:0 18px; outline:none; transition: border-color var(--transition); }
.input::placeholder { color: var(--text-muted); }
.input:focus { border-color:#bd36ff; box-shadow: 0 0 0 3px rgba(180,40,255,0.12); }
.input.invalid { border-color:#ff4d6d; }
.password-wrapper { position:relative; }
.password-wrapper .input { padding-right:50px; }
.eye { position:absolute; right:14px; top:50%; transform:translateY(-50%); width:34px; height:34px; display:flex; align-items:center; justify-content:center; color:#aeb9d9; background:transparent; border:none; cursor:pointer; font-size:18px; border-radius:50%; }
.eye:hover { color:#fff; }
.register-button { width:100%; height:58px; border:none; border-radius: var(--radius-lg); margin-top:10px; color:#fff; font-family:inherit; font-size:16px; font-weight:700; cursor:pointer; background: linear-gradient(90deg,var(--accent-1),var(--accent-2)); box-shadow: var(--shadow-button); transition: transform var(--transition); }
.register-button:hover { transform: translateY(-2px); }
.register-button:disabled { opacity:0.6; cursor:not-allowed; }
.or { display:flex; align-items:center; gap:15px; margin:25px 0 16px; color:#8992b0; font-size:13px; }
.or::before, .or::after { content:""; height:1px; flex:1; background:#283451; }
.social-buttons { display:flex; gap:15px; }
.social-button { flex:1; height:50px; border-radius: var(--radius-md); border:1px solid #2f3d63; background:#10182d; color:#fff; font-family:inherit; font-size:14px; cursor:pointer; }
.social-button:hover { border-color:#9340ff; background:#171f3a; }
.social-button.vk { color:#72a7ff; }
.already { text-align:center; margin-top:25px; color:#8e97b7; font-size:14px; }
.already a { color: var(--accent-3); font-weight:700; cursor:pointer; text-decoration:none; }
.already a:hover { text-decoration:underline; }
.error-message { color:#ff4d6d; font-size:13px; margin-top:-6px; margin-bottom:10px; min-height:18px; opacity:0; transition: opacity var(--transition); }
.error-message.visible { opacity:1; }
.success-message { color:#4ade80; font-size:13px; margin-top:-6px; margin-bottom:10px; min-height:18px; opacity:0; transition: opacity var(--transition); }
.success-message.visible { opacity:1; }
.page { display:none; }
.page.active { display:block; }

.home-container { max-width:850px; margin:0 auto; }
.welcome-card { background: linear-gradient(145deg,var(--card-bg-1),var(--card-bg-2)); border:1px solid var(--border-strong); border-radius: var(--radius-xl); padding:45px; box-shadow: var(--shadow-card); text-align:center; }
.welcome-avatar { width:110px; height:110px; border-radius:50%; margin:0 auto 20px; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-size:46px; font-weight:700; box-shadow: 0 0 35px rgba(207,28,220,0.35); overflow:hidden; }
.welcome-avatar img { width:100%; height:100%; object-fit:cover; }
.welcome-card h1 { font-size:38px; margin-bottom:12px; background: linear-gradient(90deg,#fff,#d890ff); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
.welcome-card p { color:#9aa4c7; font-size:16px; margin-bottom:25px; }
.welcome-actions { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }
.btn-secondary { height:50px; padding:0 26px; border:1px solid #34406b; border-radius: var(--radius-md); background:transparent; color:#c7cbe4; font-family:inherit; font-size:14px; cursor:pointer; }
.btn-secondary:hover { border-color: var(--accent-1); color:#fff; }

.profile-container { max-width:680px; margin:0 auto; }
.profile-card { background: linear-gradient(145deg,var(--card-bg-1),var(--card-bg-2)); border:1px solid var(--border-strong); border-radius: var(--radius-xl); padding:45px 50px; box-shadow: var(--shadow-card); }
.profile-card h1 { font-size:38px; margin-bottom:10px; background: linear-gradient(90deg,#fff,#d890ff); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
.avatar-section { display:flex; align-items:center; gap:25px; margin-bottom:30px; padding-bottom:30px; border-bottom:1px solid var(--border-soft); }
.avatar-preview { width:100px; height:100px; border-radius:50%; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-size:42px; font-weight:700; overflow:hidden; flex-shrink:0; }
.avatar-preview img { width:100%; height:100%; object-fit:cover; }
.avatar-controls { display:flex; flex-direction:column; gap:8px; }
.avatar-controls > label:first-child { font-size:13px; color: var(--text-muted); }
.btn-upload { display:inline-block; padding:10px 20px; border-radius: var(--radius-sm); border:1px solid var(--accent-2); background:transparent; color:#fff; font-family:inherit; font-size:13px; cursor:pointer; text-align:center; }
.btn-upload:hover { background: rgba(142,53,255,0.15); }
.btn-remove { display:inline-block; padding:9px 20px; border-radius: var(--radius-sm); border:1px solid #34406b; background:transparent; color: var(--text-muted); font-family:inherit; font-size:13px; cursor:pointer; }
.btn-remove:hover { color:#ff4d6d; border-color:#ff4d6d; }
.field-label { display:block; font-size:13px; color: var(--text-muted); margin-bottom:6px; margin-left:4px; }
.field-group { margin-bottom:18px; }
.field-hint { font-size:12px; color: var(--text-muted); margin-top:-8px; margin-bottom:14px; margin-left:4px; }

/* Карточки людей и друзей */
.person-item { display:flex; align-items:center; gap:14px; padding:14px; border-radius: var(--radius-md); background: rgba(20,29,54,0.5); margin-bottom:10px; border:1px solid var(--border-soft); }
.person-avatar { width:46px; height:46px; border-radius:50%; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:18px; overflow:hidden; flex-shrink:0; }
.person-avatar img { width:100%; height:100%; object-fit:cover; }
.person-info { flex:1; min-width:0; }
.person-name { font-size:15px; font-weight:600; margin-bottom:2px; }
.person-date { font-size:12px; color: var(--text-muted); }
.person-actions { display:flex; gap:8px; }

.section-subtitle { font-size: 16px; font-weight: 700; margin: 20px 0 10px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }

.chat-container { max-width:800px; margin:0 auto; }
.chat-card { background: linear-gradient(145deg,var(--card-bg-1),var(--card-bg-2)); border:1px solid var(--border-strong); border-radius: var(--radius-xl); padding:35px 40px; box-shadow: var(--shadow-card); display:flex; flex-direction:column; }
.chat-header { display:flex; align-items:center; justify-content:space-between; gap:15px; margin-bottom:10px; }
.chat-messages { height:400px; overflow-y:auto; display:flex; flex-direction:column; gap:14px; padding:18px 5px; margin-bottom:15px; border-top:1px solid var(--border-soft); border-bottom:1px solid var(--border-soft); }
.chat-msg { display:flex; gap:12px; align-items:flex-start; }
.chat-msg.own { flex-direction:row-reverse; }
.chat-msg-avatar { width:38px; height:38px; border-radius:50%; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; overflow:hidden; flex-shrink:0; }
.chat-msg-avatar img { width:100%; height:100%; object-fit:cover; }
.chat-msg-body { max-width:72%; }
.chat-msg-meta { font-size:12px; color: var(--text-muted); margin-bottom:4px; }
.chat-msg.own .chat-msg-meta { text-align:right; }
.chat-msg-bubble { background: rgba(20,29,54,0.82); border:1px solid var(--border); border-radius: var(--radius-md); padding:10px 15px; font-size:14px; line-height:1.4; word-break:break-word; white-space:pre-wrap; }
.chat-msg.own .chat-msg-bubble { background: linear-gradient(135deg, rgba(255,36,168,0.25), rgba(142,53,255,0.25)); border-color: var(--accent-2); }
.chat-empty { color:#9aa4c7; text-align:center; padding:20px; font-size:14px; }
.chat-input-row { display:flex; gap:10px; }
.chat-input { flex:1; margin-bottom:0; height:52px; }
.chat-send-btn { width:auto; padding:0 26px; height:52px; margin-top:0; flex-shrink:0; }

/* Реакции в каналах */
.channel-reactions { display:flex; gap:8px; margin-top:6px; }
.reaction-btn { background: rgba(25,30,55,0.7); border: 1px solid var(--border-soft); border-radius: 12px; padding: 4px 8px; color: var(--text-secondary); font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: all 0.2s; }
.reaction-btn:hover { border-color: var(--accent-1); color: #fff; }
.reaction-btn.active { border-color: var(--accent-1); background: rgba(255,36,168,0.18); color: #fff; }

.handle-input-wrap { position:relative; }
.handle-prefix { position:absolute; left:18px; top:50%; transform:translateY(-50%); color: var(--text-muted); font-size:15px; pointer-events:none; }
.handle-input { padding-left:32px; }

.wall-container { max-width:800px; margin:0 auto; }
.wall-card { background: linear-gradient(145deg,var(--card-bg-1),var(--card-bg-2)); border:1px solid var(--border-strong); border-radius: var(--radius-xl); padding:35px 40px; box-shadow: var(--shadow-card); }
.wall-top { display:flex; align-items:center; justify-content:space-between; gap:15px; margin-bottom:15px; }
.wall-top h1 { font-size:32px; background: linear-gradient(90deg,#fff,#d890ff); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
.wall-profile-header { display:flex; align-items:center; gap:18px; padding:18px 0; margin:10px 0 15px; border-top:1px solid var(--border-soft); border-bottom:1px solid var(--border-soft); }
.wall-profile-avatar { width:68px; height:68px; border-radius:50%; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-size:28px; font-weight:700; overflow:hidden; flex-shrink:0; }
.wall-profile-avatar img { width:100%; height:100%; object-fit:cover; }
.wall-profile-meta { flex:1; min-width:0; }
.wall-profile-name { font-size:19px; font-weight:700; }
.wall-profile-handle { font-size:13px; color: var(--text-muted); margin-top:2px; }
.wall-profile-actions { display:flex; gap:10px; flex-wrap:wrap; }

/* Блок друзей на странице профиля */
.wall-friends-box { margin-bottom:20px; padding:15px; border-radius:var(--radius-md); background:rgba(20,29,54,0.4); border:1px solid var(--border-soft); }
.wall-friends-title { font-size:14px; font-weight:600; color:var(--text-secondary); margin-bottom:10px; display:flex; justify-content:space-between; }
.wall-friends-list { display:flex; gap:10px; overflow-x:auto; padding-bottom:5px; }
.wall-friend-mini { display:flex; flex-direction:column; align-items:center; gap:5px; cursor:pointer; width:60px; text-align:center; flex-shrink:0; }
.wall-friend-mini .user-avatar { width:42px; height:42px; font-size:16px; }
.wall-friend-mini span { font-size:11px; max-width:60px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.wall-post-form { padding-bottom:22px; border-bottom:1px solid var(--border-soft); margin-bottom:22px; }
.wall-post-textarea { height:85px; padding:14px 18px; resize:vertical; font-family:inherit; font-size:14px; line-height:1.4; }
.wall-post-image-preview:empty { display:none; }
.wall-post-image-preview { position:relative; display:inline-block; margin-bottom:12px; }
.wall-post-image-preview img { max-width:200px; max-height:200px; border-radius: var(--radius-md); border:1px solid var(--border); display:block; }
.wall-image-remove { position:absolute; top:-8px; right:-8px; width:26px; height:26px; border-radius:50%; border:none; background:#ff4d6d; color:#fff; cursor:pointer; font-size:13px; }
.wall-post-actions { display:flex; align-items:center; justify-content:space-between; gap:15px; flex-wrap:wrap; }
.wall-post-submit { width:auto; padding:0 26px; height:48px; margin-top:0; }
.wall-posts { display:flex; flex-direction:column; gap:16px; }
.wall-post { background: rgba(20,29,54,0.5); border:1px solid var(--border-soft); border-radius: var(--radius-md); padding:16px 18px; }
.wall-post-head { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
.wall-post-avatar { width:40px; height:40px; border-radius:50%; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-weight:700; overflow:hidden; flex-shrink:0; }
.wall-post-avatar img { width:100%; height:100%; object-fit:cover; }
.wall-post-author { font-size:14px; font-weight:600; cursor:pointer; }
.wall-post-author:hover { color: var(--accent-3); }
.wall-post-date { font-size:11px; color: var(--text-muted); }
.wall-post-text { font-size:14px; line-height:1.5; white-space:pre-wrap; word-break:break-word; margin-bottom:10px; }
.wall-post-image img { max-width:100%; border-radius: var(--radius-md); display:block; }

.post-actions { display:flex; gap:8px; margin-top:12px; padding-top:10px; border-top:1px solid var(--border-soft); flex-wrap:wrap; }
.post-action-btn { display:flex; align-items:center; gap:6px; padding:7px 12px; border-radius: var(--radius-sm); border:1px solid var(--border-soft); background:transparent; color: var(--text-secondary); font-family:inherit; font-size:13px; cursor:pointer; transition: all var(--transition); }
.post-action-btn:hover { border-color: var(--accent-2); color:#fff; }
.post-action-btn.liked { color: #ff4d6d; border-color: #ff4d6d; background: rgba(255,77,109,0.08); }
.post-action-btn:disabled { opacity:0.5; cursor:not-allowed; }

.post-comments { margin-top:12px; padding-top:10px; border-top:1px solid var(--border-soft); display:none; }
.post-comments.open { display:block; }
.comment { display:flex; gap:10px; padding:8px 0; border-bottom:1px solid var(--border-soft); }
.comment:last-child { border-bottom:none; }
.comment-avatar { width:32px; height:32px; border-radius:50%; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; overflow:hidden; flex-shrink:0; }
.comment-avatar img { width:100%; height:100%; object-fit:cover; }
.comment-body { flex:1; min-width:0; }
.comment-meta { font-size:11px; color: var(--text-muted); margin-bottom:2px; }
.comment-meta b { color: var(--text-primary); font-weight:600; cursor:pointer; }
.comment-meta b:hover { color: var(--accent-3); }
.comment-text { font-size:13px; line-height:1.4; word-break:break-word; white-space:pre-wrap; }
.comment-form { display:flex; gap:8px; margin-top:10px; }
.comment-form input { flex:1; height:40px; margin:0; font-size:13px; }
.comment-form button { padding:0 18px; height:40px; }

.repost-block { margin:8px 0; padding:10px 12px; border-left:3px solid var(--accent-2); background: rgba(142,53,255,0.06); border-radius: var(--radius-sm); }
.repost-block-head { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
.repost-block-avatar { width:26px; height:26px; border-radius:50%; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; overflow:hidden; flex-shrink:0; }
.repost-block-avatar img { width:100%; height:100%; object-fit:cover; }
.repost-block-author { font-size:13px; font-weight:600; }
.repost-block-date { font-size:10px; color: var(--text-muted); }
.repost-block-text { font-size:13px; line-height:1.4; white-space:pre-wrap; word-break:break-word; }
.repost-block-image img { max-width:100%; border-radius: var(--radius-md); display:block; margin-top:6px; }
.repost-label { font-size:12px; color: var(--text-muted); margin-bottom:6px; }

.header-settings-btn { background:none; border:none; color: var(--text-muted); font-size:16px; cursor:pointer; padding:4px; border-radius: var(--radius-sm); line-height:1; }
.header-settings-btn:hover { color:#fff; }
.nav-badge { display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px; padding:0 4px; border-radius:9px; background:#ff4d6d; color:#fff; font-size:10px; font-weight:700; margin-left:5px; vertical-align:middle; line-height:1; }
.nav-badge.hidden { display:none; }
.messages-list { display:flex; flex-direction:column; gap:8px; }
.message-row { display:flex; align-items:center; gap:12px; padding:12px; border-radius: var(--radius-md); background: rgba(20,29,54,0.5); border:1px solid var(--border-soft); cursor:pointer; transition: border-color var(--transition); }
.message-row:hover { border-color: var(--accent-2); }
.message-row.unread { border-color: var(--accent-2); background: rgba(142,53,255,0.12); }
.message-row-avatar { width:46px; height:46px; border-radius:50%; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:18px; overflow:hidden; flex-shrink:0; }
.message-row-avatar img { width:100%; height:100%; object-fit:cover; }
.message-row-body { flex:1; min-width:0; }
.message-row-top { display:flex; justify-content:space-between; gap:8px; }
.message-row-name { font-size:14px; font-weight:600; }
.message-row-time { font-size:11px; color: var(--text-muted); flex-shrink:0; }
.message-row-preview { font-size:12px; color: var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px; }
.message-row.unread .message-row-preview { color:#fff; font-weight:600; }
.message-row-unread-count { flex-shrink:0; min-width:18px; height:18px; padding:0 5px; border-radius:9px; background: linear-gradient(135deg,var(--accent-1),var(--accent-2)); color:#fff; font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; }

.fab-create { position:fixed; right:25px; bottom:25px; width:58px; height:58px; border:0; border-radius:50%; background:linear-gradient(135deg,var(--accent-1),var(--accent-2)); color:#fff; font-size:30px; line-height:58px; cursor:pointer; z-index:30; box-shadow:0 10px 30px rgba(207,28,220,.35); }
.fab-create:hover { transform:translateY(-2px); }
.create-menu { position:fixed; right:25px; bottom:92px; width:220px; padding:8px; border:1px solid var(--border-strong); border-radius:16px; background:linear-gradient(145deg,var(--card-bg-1),var(--card-bg-2)); box-shadow:var(--shadow-card); z-index:29; }
.create-menu button { width:100%; padding:11px 12px; border:0; border-radius:10px; background:transparent; color:#fff; text-align:left; font-family:inherit; font-size:14px; cursor:pointer; }
.create-menu button:hover { background:rgba(142,53,255,.15); }

.modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.65); display:flex; align-items:center; justify-content:center; z-index:50; padding:15px; }
.modal-card { width:min(520px,100%); max-height:90vh; overflow:auto; background:linear-gradient(145deg,var(--card-bg-1),var(--card-bg-2)); border:1px solid var(--border-strong); border-radius:var(--radius-xl); padding:30px; box-shadow:var(--shadow-card); }
.modal-card h2 { font-size:26px; margin-bottom:8px; }
.modal-card .description { margin-bottom:20px; }
.modal-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:15px; }
.modal-actions .register-button { width:auto; padding:0 24px; margin-top:0; height:46px; }
.modal-actions .btn-secondary { height:46px; padding:0 20px; }

.confirm-modal-box {
    background: linear-gradient(145deg, var(--card-bg-1), var(--card-bg-2));
    border: 1px solid var(--border-strong); border-radius: var(--radius-lg);
    padding: 25px; text-align: center; max-width: 340px; width: 90%;
    box-shadow: var(--shadow-card);
}
.confirm-modal-box h3 { margin-bottom: 18px; font-size: 17px; }
.confirm-modal-btns { display: flex; gap: 10px; justify-content: center; }

.hidden { display:none !important; }
</style>
</head>
<body>

<header>
    <a class="logo" id="logo-link">
        <span class="logo-fire">🔥</span>
        <span class="logo-text">Hot</span>
    </a>
    <nav id="main-nav">
        <a id="nav-home" class="active">Главная</a>
        <a id="nav-feed">Посты</a>
        <a id="nav-people">Люди</a>
        <a id="nav-friends">Друзья<span class="nav-badge hidden" id="nav-friends-badge">0</span></a>
        <a id="nav-wall">Страница</a>
        <a id="nav-messages">Сообщения<span class="nav-badge hidden" id="nav-messages-badge">0</span></a>
    </nav>
    <div class="header-right">
        <!-- Поиск в шапке -->
        <div class="search-container">
            <div class="search">
                <span class="search-icon">⌕</span>
                <input type="search" id="global-search-input" placeholder="Поиск людей и каналов...">
            </div>
            <div id="global-search-dropdown" class="global-search-dropdown hidden"></div>
        </div>

        <!-- Кнопка смены языка -->
        <button type="button" class="lang-btn" id="lang-btn">ENG</button>

        <button type="button" class="login-top" id="header-login-btn">Войти</button>

        <!-- Меню мультиаккаунта -->
        <div class="user-menu-wrapper">
            <div class="user-info hidden" id="header-user">
                <div class="user-avatar" id="header-avatar">?</div>
                <span class="user-name" id="header-username"></span>
                <button type="button" class="account-arrow-btn" id="account-arrow-btn" title="Аккаунты">▼</button>
                <button type="button" class="header-settings-btn" id="header-settings-btn" title="Настройки">⚙️</button>
            </div>
            <div id="account-dropdown" class="account-dropdown hidden">
                <div id="account-list"></div>
                <button type="button" class="add-account-btn" id="add-account-btn">+ Добавить аккаунт</button>
            </div>
        </div>
    </div>
</header>

<main>

<!-- Страница Авторизации -->
<div class="page active" id="page-auth">
    <div class="main-auth">
        <section class="hero">
            <div class="hero-logo">
                <span class="hero-fire">🔥</span>
                <span class="hero-title">Hot</span>
            </div>
            <p class="hero-subtitle" id="hero-subtitle-text">Социальная сеть</p>
        </section>
        <section class="registration">
            <h1 id="auth-title">Регистрация</h1>
            <p class="description" id="auth-description">Создай аккаунт и начни общаться</p>
            <form id="register-form" novalidate>
                <input id="username" class="input" type="text" placeholder="Имя пользователя" minlength="3" maxlength="20">
                <input id="email" class="input" type="email" placeholder="Почта">
                <div class="password-wrapper">
                    <input id="password" class="input" type="password" placeholder="Пароль">
                    <button type="button" class="eye" data-target="password">◉</button>
                </div>
                <div class="password-wrapper" id="password2-wrapper">
                    <input id="password2" class="input" type="password" placeholder="Повторите пароль">
                    <button type="button" class="eye" data-target="password2">◉</button>
                </div>
                <p id="error" class="error-message"></p>
                <button type="submit" class="register-button" id="submit-btn">Создать аккаунт →</button>
            </form>
            <div class="or" id="or-divider">или</div>
            <div class="social-buttons" id="social-block">
                <button type="button" class="social-button">Google</button>
                <button type="button" class="social-button vk">VK</button>
            </div>
            <p class="already" id="switch-line">Уже есть аккаунт? <a id="switch-mode">Войти</a></p>
        </section>
    </div>
</div>

<!-- Главная -->
<div class="page" id="page-home">
    <div class="home-container">
        <div class="welcome-card">
            <div class="welcome-avatar" id="home-avatar">?</div>
            <h1 id="home-title">Привет!</h1>
            <p id="home-text">Ты успешно вошёл в Hot</p>
            <div class="welcome-actions">
                <button type="button" class="btn-secondary" id="home-feed-btn">Посты</button>
                <button type="button" class="btn-secondary" id="home-friends-btn">Друзья</button>
                <button type="button" class="btn-secondary" id="home-wall-btn">Страница</button>
                <button type="button" class="btn-secondary" id="home-messages-btn">Сообщения<span class="nav-badge hidden" id="home-messages-badge">0</span></button>
                <button type="button" class="btn-secondary" id="home-logout-btn">Выйти</button>
            </div>
        </div>
    </div>
</div>

<!-- Настройки профиля -->
<div class="page" id="page-profile">
    <div class="profile-container">
        <div class="profile-card">
            <h1 id="profile-heading">Настройки профиля</h1>
            <p class="description" id="profile-subheading">Измени свой ник и аватар</p>
            <form id="profile-form" novalidate>
                <div class="avatar-section">
                    <div class="avatar-preview" id="profile-avatar-preview">?</div>
                    <div class="avatar-controls">
                        <label id="profile-avatar-label">Аватар (JPG, PNG, до 10 МБ)</label>
                        <label class="btn-upload" for="avatar-input" id="profile-upload-label">Загрузить картинку</label>
                        <input type="file" id="avatar-input" accept="image/*" style="display:none;">
                        <button type="button" class="btn-remove" id="avatar-remove-btn">Удалить аватар</button>
                    </div>
                </div>
                <div class="field-group">
                    <label class="field-label" id="profile-username-label">Ник</label>
                    <input id="profile-username" class="input" type="text" minlength="3" maxlength="20">
                    <div class="field-hint" id="profile-hint-len">От 3 до 20 символов</div>
                </div>
                <div class="field-group">
                    <label class="field-label" id="profile-handle-label">Юзернейм (для поиска)</label>
                    <div class="handle-input-wrap">
                        <span class="handle-prefix">@</span>
                        <input id="profile-handle" class="input handle-input" type="text" placeholder="username" maxlength="20">
                    </div>
                    <div class="field-hint" id="profile-hint-handle">Латиница, цифры и _, от 3 до 20 символов. Необязательно.</div>
                </div>
                <div class="field-group">
                    <label class="field-label">Email</label>
                    <input id="profile-email" class="input" type="email" disabled>
                    <div class="field-hint" id="profile-hint-email">Email изменить нельзя</div>
                </div>
                <p id="profile-error" class="error-message"></p>
                <p id="profile-success" class="success-message"></p>
                <button type="submit" class="register-button" id="profile-submit-btn">Сохранить изменения</button>
                <div style="margin-top:20px; text-align:center;">
                    <button type="button" class="btn-secondary" id="profile-back-btn">Назад на главную</button>
                </div>
            </form>
        </div>
    </div>
</div>

<!-- Список людей -->
<div class="page" id="page-people">
    <div class="profile-container">
        <div class="profile-card">
            <h1 id="people-title">Люди</h1>
            <p class="description" id="people-desc">Все пользователи Hot</p>
            <div id="people-list"></div>
        </div>
    </div>
</div>

<!-- Вкладка Друзья (Друзья + Заявки в друзья) -->
<div class="page" id="page-friends">
    <div class="profile-container">
        <div class="profile-card">
            <h1 id="friends-title">Друзья</h1>
            <p class="description" id="friends-desc">Список друзей и входящие заявки</p>
            
            <div id="incoming-requests-section" class="hidden">
                <div class="section-subtitle" id="incoming-req-title" style="color:var(--accent-1);">Заявки в друзья</div>
                <div id="incoming-requests-list"></div>
            </div>

            <div class="section-subtitle" id="my-friends-title">Мои друзья</div>
            <div id="friends-list"></div>
        </div>
    </div>
</div>

<!-- Лента постов -->
<div class="page" id="page-feed">
    <div class="wall-container">
        <div class="wall-card">
            <div class="wall-top">
                <h1 id="feed-title">Посты</h1>
                <button type="button" class="btn-secondary" id="feed-back-btn">На главную</button>
            </div>
            <p class="description" id="feed-desc">Лента всех постов пользователей Hot</p>
            <div id="feed-posts" class="wall-posts"></div>
        </div>
    </div>
</div>

<!-- Стена (Страница профиля) -->
<div class="page" id="page-wall">
    <div class="wall-container">
        <div class="wall-card">
            <div class="wall-top">
                <h1 id="wall-title">Страница</h1>
                <button type="button" class="btn-secondary" id="wall-back-btn">На главную</button>
            </div>
            <div id="wall-profile-header" class="wall-profile-header"></div>
            
            <!-- Блок друзей профиля -->
            <div id="wall-friends-box" class="wall-friends-box hidden">
                <div class="wall-friends-title"><span id="wall-friends-title-text">Друзья</span> <span id="wall-friends-count" style="color:var(--accent-1);">0</span></div>
                <div id="wall-friends-list" class="wall-friends-list"></div>
            </div>

            <form id="wall-post-form" class="wall-post-form hidden">
                <textarea id="wall-post-text" class="input wall-post-textarea" placeholder="Что нового?" maxlength="3000"></textarea>
                <div id="wall-post-image-preview" class="wall-post-image-preview"></div>
                <div class="wall-post-actions">
                    <div>
                        <label class="btn-upload" for="wall-post-image-input" id="post-add-image-btn">Добавить картинку</label>
                        <input type="file" id="wall-post-image-input" accept="image/*" style="display:none;">
                    </div>
                    <button type="submit" class="register-button wall-post-submit" id="wall-post-submit-btn">Опубликовать</button>
                </div>
                <p id="wall-post-error" class="error-message"></p>
            </form>
            <div id="wall-posts" class="wall-posts"></div>
        </div>
    </div>
</div>

<!-- Канал -->
<div class="page" id="page-channel">
    <div class="chat-container">
        <div class="chat-card">
            <div class="chat-header">
                <div id="channel-page-info"></div>
                <div style="display:flex;gap:8px;">
                    <button type="button" class="btn-secondary hidden" id="channel-settings-btn">⚙️</button>
                    <button type="button" class="btn-secondary" id="channel-back-btn">Назад</button>
                </div>
            </div>
            <div class="chat-messages" id="channel-messages"></div>
            <form id="channel-message-form" class="chat-input-row" autocomplete="off">
                <input id="channel-message-input" class="input chat-input" type="text" placeholder="Новое сообщение в канал..." maxlength="2000">
                <button type="submit" class="register-button chat-send-btn" id="channel-post-btn">Опубликовать</button>
            </form>
            <p id="channel-message-error" class="error-message"></p>
        </div>
    </div>
</div>

<!-- Групповой чат -->
<div class="page" id="page-groupchat">
    <div class="chat-container">
        <div class="chat-card">
            <div class="chat-header"><div id="groupchat-info"></div><button type="button" class="btn-secondary" id="groupchat-back-btn">Назад</button></div>
            <div class="chat-messages" id="groupchat-messages"></div>
            <form id="groupchat-form" class="chat-input-row" autocomplete="off"><input id="groupchat-input" class="input chat-input" type="text" placeholder="Написать сообщение..." maxlength="2000"><button type="submit" class="register-button chat-send-btn" id="groupchat-send-btn">Отправить</button></form>
            <p id="groupchat-error" class="error-message"></p>
        </div>
    </div>
</div>

<!-- Личные сообщения -->
<div class="page" id="page-dm">
    <div class="chat-container">
        <div class="chat-card">
            <div class="chat-header">
                <div class="dm-partner" id="dm-partner-info"></div>
                <button type="button" class="btn-secondary" id="dm-back-btn">Назад</button>
            </div>
            <div class="chat-messages" id="dm-messages"></div>
            <form id="dm-form" class="chat-input-row" autocomplete="off">
                <input id="dm-input" class="input chat-input" type="text" placeholder="Написать сообщение..." maxlength="2000">
                <button type="submit" class="register-button chat-send-btn" id="dm-send-btn">Отправить</button>
            </form>
            <p id="dm-error" class="error-message"></p>
        </div>
    </div>
</div>

<!-- Список всех сообщений -->
<div class="page" id="page-messages">
    <div class="wall-container">
        <div class="wall-card">
            <div class="wall-top">
                <h1 id="messages-title">Сообщения</h1>
                <button type="button" class="btn-secondary" id="messages-back-btn">На главную</button>
            </div>
            <div id="messages-list" class="messages-list"></div>
        </div>
    </div>
</div>

</main>

<!-- Модалка подтверждения выхода -->
<div class="modal-backdrop hidden" id="logout-confirm-modal">
    <div class="confirm-modal-box">
        <h3 id="logout-modal-title">Вы точно хотите выйти?</h3>
        <div class="confirm-modal-btns">
            <button type="button" class="register-button" style="padding:0 25px;height:45px;margin-top:0;" id="logout-confirm-yes">Да</button>
            <button type="button" class="btn-secondary" style="height:45px;" id="logout-confirm-no">Нет</button>
        </div>
    </div>
</div>

<!-- FAB кнопка создания -->
<button type="button" class="fab-create hidden" id="fab-create" title="Создать">+</button>
<div class="create-menu hidden" id="create-menu">
    <button type="button" id="create-channel-btn">📢 Создать канал</button>
    <button type="button" id="create-chat-btn">💬 Создать чат</button>
</div>

<!-- Модалка создания канала -->
<div class="modal-backdrop hidden" id="channel-modal">
    <div class="modal-card">
        <h2 id="channel-modal-title">📢 Создать канал</h2>
        <p class="description" id="channel-modal-desc">Придумай название и уникальный юзернейм канала.</p>
        <input id="channel-name-input" class="input" type="text" placeholder="Название канала" maxlength="40">
        <div class="handle-input-wrap"><span class="handle-prefix">@</span><input id="channel-username-input" class="input handle-input" type="text" placeholder="username" maxlength="20"></div>
        <textarea id="channel-description-input" class="input" style="height:90px;padding:14px 18px;resize:vertical;" placeholder="Описание канала" maxlength="500"></textarea>
        <p id="channel-create-error" class="error-message"></p>
        <div class="modal-actions">
            <button type="button" class="btn-secondary" id="channel-cancel-btn">Отмена</button>
            <button type="button" class="register-button" id="channel-save-btn">Создать</button>
        </div>
    </div>
</div>

<!-- Модалка настроек канала -->
<div class="modal-backdrop hidden" id="channel-edit-modal">
    <div class="modal-card">
        <h2 id="channel-edit-title">⚙️ Настройки канала</h2>
        <p class="description" id="channel-edit-desc">Измени аватар, имя, юзернейм и описание канала</p>
        <div class="avatar-section" style="margin-bottom:20px;padding-bottom:20px;">
            <div class="avatar-preview" id="channel-edit-avatar-preview">📢</div>
            <div class="avatar-controls">
                <label>Аватарка канала</label>
                <label class="btn-upload" for="channel-avatar-input" id="ch-upload-btn-text">Загрузить аватар</label>
                <input type="file" id="channel-avatar-input" accept="image/*" style="display:none;">
            </div>
        </div>
        <input id="channel-edit-name" class="input" type="text" placeholder="Название канала" maxlength="40">
        <div class="handle-input-wrap"><span class="handle-prefix">@</span><input id="channel-edit-username" class="input handle-input" type="text" placeholder="username" maxlength="20"></div>
        <textarea id="channel-edit-description" class="input" style="height:90px;padding:14px 18px;resize:vertical;" placeholder="Описание канала" maxlength="500"></textarea>
        <p id="channel-edit-error" class="error-message"></p>
        <div class="modal-actions">
            <button type="button" class="btn-secondary" id="channel-edit-cancel">Отмена</button>
            <button type="button" class="register-button" id="channel-edit-save">Сохранить</button>
        </div>
    </div>
</div>

<!-- Модалка создания чата -->
<div class="modal-backdrop hidden" id="chat-modal">
    <div class="modal-card">
        <h2 id="chat-modal-title">💬 Создать чат</h2>
        <p class="description" id="chat-modal-desc">Создай групповой чат и добавь участников через их имена.</p>
        <input id="chat-name-input" class="input" type="text" placeholder="Название чата" maxlength="40">
        <input id="chat-members-input" class="input" type="text" placeholder="Участники через запятую, например Alex, Max">
        <p id="chat-create-error" class="error-message"></p>
        <div class="modal-actions">
            <button type="button" class="btn-secondary" id="chat-cancel-btn">Отмена</button>
            <button type="button" class="register-button" id="chat-save-btn">Создать</button>
        </div>
    </div>
</div>

<script>
(function () {
    'use strict';

    var API = '';
    var STORAGE_SESSION = 'hot_session';
    var MAX_AVATAR_SIZE = 10 * 1024 * 1024;
    var AVATAR_DIMENSION = 200;
    var MAX_POST_IMAGE_SIZE = 10 * 1024 * 1024;
    var POST_IMAGE_MAX_DIM = 1280;

    var currentUser = null;
    var pendingAvatar = null;
    var pendingChannelAvatar = null;
    var pendingWallImage = '';
    var wallViewingUsername = null;
    var currentChannelData = null;

    function getSession() { return localStorage.getItem(STORAGE_SESSION); }
    function setSession(u) { localStorage.setItem(STORAGE_SESSION, u); }
    function clearSession() { localStorage.removeItem(STORAGE_SESSION); }

    function apiPost(path, data) {
        return fetch(API + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).then(function (res) {
            return res.json().then(function (json) {
                if (!res.ok) throw new Error(json.error || 'Ошибка');
                return json;
            });
        });
    }
    function apiGet(path) {
        return fetch(API + path).then(function (res) { return res.json(); });
    }

    /* ---------- МУЛЬТИЯЗЫЧНОСТЬ (I18N) ---------- */
    var currentLang = localStorage.getItem('hot_lang') || 'ru';
    var I18N = {
        ru: {
            navHome: "Главная", navFeed: "Посты", navPeople: "Люди", navFriends: "Друзья", navWall: "Страница", navMessages: "Сообщения",
            searchPlaceholder: "Поиск людей и каналов...",
            logoutTitle: "Вы точно хотите выйти?", yes: "Да", no: "Нет",
            addAccount: "+ Добавить аккаунт", subscribe: "Подписаться", unsubscribe: "Отписаться",
            exactMatch: "Точное совпадение", loginBtn: "Войти", logoutBtn: "Выйти",
            regTitle: "Регистрация", regDesc: "Создай аккаунт и начни общаться",
            loginTitle: "Вход", loginDesc: "Войди в свой аккаунт",
            submitReg: "Создать аккаунт →", submitLogin: "Войти →",
            alreadyHave: "Уже есть аккаунт? ", noAccount: "Нет аккаунта? ",
            createChannel: "📢 Создать канал", createChat: "💬 Создать чат",
            settingsChannel: "⚙️ Настройки канала", channelSettingsDesc: "Измени аватар, имя, юзернейм и описание канала",
            saveChanges: "Сохранить изменения", save: "Сохранить", cancel: "Отмена", create: "Создать",
            publish: "Опубликовать", send: "Отправить",
            addFriend: "Добавить в друзья", removeFriend: "Удалить из друзей",
            reqSent: "Заявка отправлена (Отменить)", accept: "Принять", decline: "Отклонить",
            incomingReqsTitle: "Заявки в друзья", myFriendsTitle: "Мои друзья",
            friendsBlockTitle: "Друзья", noFriends: "Пока нет друзей",
            heroSub: "Социальная сеть", profileSettings: "Настройки профиля",
            profileSub: "Измени свой ник и аватар", backToHome: "Назад на главную", back: "Назад",
            like: "Нравится", repost: "Репост", reposted: "Репостнуто", writeMsg: "Написать сообщение",
            postPlaceholder: "Что нового?", addPic: "Добавить картинку"
        },
        en: {
            navHome: "Home", navFeed: "Posts", navPeople: "People", navFriends: "Friends", navWall: "Profile", navMessages: "Messages",
            searchPlaceholder: "Search people & channels...",
            logoutTitle: "Are you sure you want to log out?", yes: "Yes", no: "No",
            addAccount: "+ Add account", subscribe: "Subscribe", unsubscribe: "Unsubscribe",
            exactMatch: "Exact match", loginBtn: "Log in", logoutBtn: "Log out",
            regTitle: "Sign Up", regDesc: "Create an account and start connecting",
            loginTitle: "Log In", loginDesc: "Sign in to your account",
            submitReg: "Create account →", submitLogin: "Log in →",
            alreadyHave: "Already have an account? ", noAccount: "Don't have an account? ",
            createChannel: "📢 Create Channel", createChat: "💬 Create Chat",
            settingsChannel: "⚙️ Channel Settings", channelSettingsDesc: "Change channel avatar, name, username and description",
            saveChanges: "Save Changes", save: "Save", cancel: "Cancel", create: "Create",
            publish: "Publish", send: "Send",
            addFriend: "Add Friend", removeFriend: "Remove Friend",
            reqSent: "Request Sent (Cancel)", accept: "Accept", decline: "Decline",
            incomingReqsTitle: "Friend Requests", myFriendsTitle: "My Friends",
            friendsBlockTitle: "Friends", noFriends: "No friends yet",
            heroSub: "Social Network", profileSettings: "Profile Settings",
            profileSub: "Change your username and avatar", backToHome: "Back to Home", back: "Back",
            like: "Like", repost: "Repost", reposted: "Reposted", writeMsg: "Message",
            postPlaceholder: "What's new?", addPic: "Add photo"
        }
    };

    function applyLanguage() {
        var t = I18N[currentLang];
        document.getElementById('nav-home').textContent = t.navHome;
        document.getElementById('nav-feed').textContent = t.navFeed;
        document.getElementById('nav-people').textContent = t.navPeople;
        
        var frNavText = t.navFriends;
        var frBadge = document.getElementById('nav-friends-badge');
        document.getElementById('nav-friends').innerHTML = frNavText + '<span class="nav-badge ' + (frBadge.classList.contains('hidden') ? 'hidden' : '') + '" id="nav-friends-badge">' + frBadge.textContent + '</span>';
        
        document.getElementById('nav-wall').textContent = t.navWall;
        document.getElementById('global-search-input').placeholder = t.searchPlaceholder;
        document.getElementById('logout-modal-title').textContent = t.logoutTitle;
        document.getElementById('logout-confirm-yes').textContent = t.yes;
        document.getElementById('logout-confirm-no').textContent = t.no;
        document.getElementById('add-account-btn').textContent = t.addAccount;
        document.getElementById('lang-btn').textContent = currentLang === 'ru' ? 'ENG' : 'RUS';
        document.getElementById('header-login-btn').textContent = t.loginBtn;
        document.getElementById('home-logout-btn').textContent = t.logoutBtn;
        document.getElementById('hero-subtitle-text').textContent = t.heroSub;
        document.getElementById('create-channel-btn').textContent = t.createChannel;
        document.getElementById('create-chat-btn').textContent = t.createChat;
        document.getElementById('profile-heading').textContent = t.profileSettings;
        document.getElementById('profile-subheading').textContent = t.profileSub;
        document.getElementById('profile-submit-btn').textContent = t.saveChanges;
        document.getElementById('profile-back-btn').textContent = t.backToHome;
        document.getElementById('feed-back-btn').textContent = t.backToHome;
        document.getElementById('wall-back-btn').textContent = t.backToHome;
        document.getElementById('messages-back-btn').textContent = t.backToHome;
        document.getElementById('channel-back-btn').textContent = t.back;
        document.getElementById('groupchat-back-btn').textContent = t.back;
        document.getElementById('dm-back-btn').textContent = t.back;
        document.getElementById('wall-friends-title-text').textContent = t.friendsBlockTitle;
        document.getElementById('incoming-req-title').textContent = t.incomingReqsTitle;
        document.getElementById('my-friends-title').textContent = t.myFriendsTitle;
        document.getElementById('wall-post-text').placeholder = t.postPlaceholder;
        document.getElementById('post-add-image-btn').textContent = t.addPic;
        document.getElementById('wall-post-submit-btn').textContent = t.publish;
        document.getElementById('channel-cancel-btn').textContent = t.cancel;
        document.getElementById('channel-save-btn').textContent = t.create;
        document.getElementById('channel-edit-cancel').textContent = t.cancel;
        document.getElementById('channel-edit-save').textContent = t.save;
        document.getElementById('chat-cancel-btn').textContent = t.cancel;
        document.getElementById('chat-save-btn').textContent = t.create;
        document.getElementById('channel-post-btn').textContent = t.publish;
        document.getElementById('groupchat-send-btn').textContent = t.send;
        document.getElementById('dm-send-btn').textContent = t.send;

        if (mode === 'register') {
            document.getElementById('auth-title').textContent = t.regTitle;
            document.getElementById('auth-description').textContent = t.regDesc;
            document.getElementById('submit-btn').textContent = t.submitReg;
            document.getElementById('switch-line').innerHTML = t.alreadyHave + '<a id="switch-mode">' + t.loginBtn + '</a>';
        } else {
            document.getElementById('auth-title').textContent = t.loginTitle;
            document.getElementById('auth-description').textContent = t.loginDesc;
            document.getElementById('submit-btn').textContent = t.submitLogin;
            document.getElementById('switch-line').innerHTML = t.noAccount + '<a id="switch-mode">' + (currentLang==='ru'?'Зарегистрироваться':'Sign Up') + '</a>';
        }
        bindSwitch();
    }

    document.getElementById('lang-btn').addEventListener('click', function() {
        currentLang = currentLang === 'ru' ? 'en' : 'ru';
        localStorage.setItem('hot_lang', currentLang);
        applyLanguage();
    });

    /* ---------- МУЛЬТИАККАУНТ И УСТРАНЕНИЕ БАГА ПРИ СМЕНЕ НИКА ---------- */
    function getAccounts() {
        try { return JSON.parse(localStorage.getItem('hot_saved_accounts') || '[]'); }
        catch(e) { return []; }
    }
    function saveAccountToStore(u, oldUsername) {
        if (!u || !u.username) return;
        var list = getAccounts();
        var searchName = (oldUsername || u.username).toLowerCase();
        list = list.filter(function(a) { return a.username.toLowerCase() !== searchName && a.username.toLowerCase() !== u.username.toLowerCase(); });
        list.unshift({ username: u.username, email: u.email, avatar: u.avatar || '', handle: u.handle || '' });
        localStorage.setItem('hot_saved_accounts', JSON.stringify(list));
    }
    function removeAccountFromStore(username) {
        var list = getAccounts().filter(function(a) { return a.username.toLowerCase() !== username.toLowerCase(); });
        localStorage.setItem('hot_saved_accounts', JSON.stringify(list));
    }

    var accountArrowBtn = document.getElementById('account-arrow-btn');
    var accountDropdown = document.getElementById('account-dropdown');
    var accountListEl = document.getElementById('account-list');

    accountArrowBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        renderAccountDropdown();
        accountDropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', function(e) {
        if (!accountDropdown.contains(e.target) && e.target !== accountArrowBtn) {
            accountDropdown.classList.add('hidden');
        }
    });

    function renderAccountDropdown() {
        var list = getAccounts();
        var html = '';
        list.forEach(function(acc) {
            var active = currentUser && acc.username.toLowerCase() === currentUser.username.toLowerCase();
            html += '<div class="account-dropdown-item' + (active ? ' active' : '') + '" data-switch="' + escapeHtml(acc.username) + '">'
                + '<div class="user-avatar" style="width:30px;height:30px;font-size:13px;">' + avatarHTML(acc) + '</div>'
                + '<span style="font-size:13px;font-weight:600;">' + escapeHtml(acc.username) + '</span>'
                + '</div>';
        });
        accountListEl.innerHTML = html;
        accountListEl.querySelectorAll('.account-dropdown-item').forEach(function(el) {
            el.addEventListener('click', function() {
                var targetName = el.getAttribute('data-switch');
                switchAccount(targetName);
                accountDropdown.classList.add('hidden');
            });
        });
    }

    function switchAccount(username) {
        apiGet('/api/users').then(function(res) {
            var found = (res.users || []).find(function(u) { return u.username.toLowerCase() === username.toLowerCase(); });
            if (found) {
                currentUser = found;
                setSession(found.username);
                saveAccountToStore(found);
                updateHeader(found); updateHome(found); updateProfile(found);
                showPage('home');
                startUnreadPolling();
                updateFriendRequestsBadge();
            }
        });
    }

    document.getElementById('add-account-btn').addEventListener('click', function() {
        accountDropdown.classList.add('hidden');
        setMode('register');
        showPage('auth');
    });

    /* ---------- СТРАНИЦЫ И НАВИГАЦИЯ ---------- */
    var pageAuth = document.getElementById('page-auth');
    var pageHome = document.getElementById('page-home');
    var pageProfile = document.getElementById('page-profile');
    var pagePeople = document.getElementById('page-people');
    var pageFriends = document.getElementById('page-friends');
    var pageFeed = document.getElementById('page-feed');
    var pageWall = document.getElementById('page-wall');
    var pageDm = document.getElementById('page-dm');
    var pageMessages = document.getElementById('page-messages');
    var pageChannel = document.getElementById('page-channel');
    var pageGroupChat = document.getElementById('page-groupchat');

    var navHome = document.getElementById('nav-home');
    var navFeed = document.getElementById('nav-feed');
    var navPeople = document.getElementById('nav-people');
    var navFriends = document.getElementById('nav-friends');
    var navWall = document.getElementById('nav-wall');
    var navMessages = document.getElementById('nav-messages');
    var navMessagesBadge = document.getElementById('nav-messages-badge');
    var mainNav = document.getElementById('main-nav');

    var fabCreate = document.getElementById('fab-create');
    var createMenu = document.getElementById('create-menu');
    var channelModal = document.getElementById('channel-modal');
    var chatModal = document.getElementById('chat-modal');
    var channelNameInput = document.getElementById('channel-name-input');
    var channelUsernameInput = document.getElementById('channel-username-input');
    var channelDescriptionInput = document.getElementById('channel-description-input');
    var channelCreateError = document.getElementById('channel-create-error');
    var channelPageInfo = document.getElementById('channel-page-info');
    var channelMessagesEl = document.getElementById('channel-messages');
    var channelMessageForm = document.getElementById('channel-message-form');
    var channelMessageInput = document.getElementById('channel-message-input');
    var channelMessageError = document.getElementById('channel-message-error');
    var channelBackBtn = document.getElementById('channel-back-btn');
    var channelSettingsBtn = document.getElementById('channel-settings-btn');

    var channelEditModal = document.getElementById('channel-edit-modal');
    var channelEditName = document.getElementById('channel-edit-name');
    var channelEditUsername = document.getElementById('channel-edit-username');
    var channelEditDescription = document.getElementById('channel-edit-description');
    var channelEditError = document.getElementById('channel-edit-error');
    var channelEditAvatarPreview = document.getElementById('channel-edit-avatar-preview');
    var channelAvatarInput = document.getElementById('channel-avatar-input');

    var chatNameInput = document.getElementById('chat-name-input');
    var chatMembersInput = document.getElementById('chat-members-input');
    var chatCreateError = document.getElementById('chat-create-error');
    var groupchatInfo = document.getElementById('groupchat-info');
    var groupchatMessagesEl = document.getElementById('groupchat-messages');
    var groupchatForm = document.getElementById('groupchat-form');
    var groupchatInput = document.getElementById('groupchat-input');
    var groupchatBackBtn = document.getElementById('groupchat-back-btn');
    var activeChannelUsername = null;
    var activeGroupChatId = null;
    var groupChatReturnTo = 'messages';

    var headerLoginBtn = document.getElementById('header-login-btn');
    var headerUser = document.getElementById('header-user');
    var headerAvatar = document.getElementById('header-avatar');
    var headerUsername = document.getElementById('header-username');
    var headerSettingsBtn = document.getElementById('header-settings-btn');

    var submitBtn = document.getElementById('submit-btn');
    var form = document.getElementById('register-form');
    var usernameInput = document.getElementById('username');
    var emailInput = document.getElementById('email');
    var passwordInput = document.getElementById('password');
    var password2Input = document.getElementById('password2');
    var password2Wrapper = document.getElementById('password2-wrapper');
    var errorEl = document.getElementById('error');
    var switchLine = document.getElementById('switch-line');
    var orDivider = document.getElementById('or-divider');
    var socialBlock = document.getElementById('social-block');

    var homeAvatar = document.getElementById('home-avatar');
    var homeTitle = document.getElementById('home-title');
    var homeText = document.getElementById('home-text');
    var homeLogoutBtn = document.getElementById('home-logout-btn');
    var homeWallBtn = document.getElementById('home-wall-btn');
    var homeFeedBtn = document.getElementById('home-feed-btn');
    var homeFriendsBtn = document.getElementById('home-friends-btn');
    var homeMessagesBtn = document.getElementById('home-messages-btn');
    var homeMessagesBadge = document.getElementById('home-messages-badge');

    var profileForm = document.getElementById('profile-form');
    var profileAvatarPreview = document.getElementById('profile-avatar-preview');
    var profileUsername = document.getElementById('profile-username');
    var profileHandle = document.getElementById('profile-handle');
    var profileEmail = document.getElementById('profile-email');
    var avatarInput = document.getElementById('avatar-input');
    var avatarRemoveBtn = document.getElementById('avatar-remove-btn');
    var profileError = document.getElementById('profile-error');
    var profileSuccess = document.getElementById('profile-success');
    var profileSubmitBtn = document.getElementById('profile-submit-btn');
    var profileBackBtn = document.getElementById('profile-back-btn');

    var peopleList = document.getElementById('people-list');
    var friendsList = document.getElementById('friends-list');
    var incomingRequestsSection = document.getElementById('incoming-requests-section');
    var incomingRequestsList = document.getElementById('incoming-requests-list');

    var feedBackBtn = document.getElementById('feed-back-btn');
    var feedPostsEl = document.getElementById('feed-posts');

    var wallBackBtn = document.getElementById('wall-back-btn');
    var wallProfileHeader = document.getElementById('wall-profile-header');
    var wallFriendsBox = document.getElementById('wall-friends-box');
    var wallFriendsList = document.getElementById('wall-friends-list');
    var wallFriendsCount = document.getElementById('wall-friends-count');
    var wallPostForm = document.getElementById('wall-post-form');
    var wallPostText = document.getElementById('wall-post-text');
    var wallPostImageInput = document.getElementById('wall-post-image-input');
    var wallPostImagePreview = document.getElementById('wall-post-image-preview');
    var wallPostError = document.getElementById('wall-post-error');
    var wallPostSubmitBtn = document.getElementById('wall-post-submit-btn');
    var wallPostsEl = document.getElementById('wall-posts');

    var dmPartnerInfo = document.getElementById('dm-partner-info');
    var dmMessagesEl = document.getElementById('dm-messages');
    var dmForm = document.getElementById('dm-form');
    var dmInput = document.getElementById('dm-input');
    var dmError = document.getElementById('dm-error');
    var dmSendBtn = document.getElementById('dm-send-btn');
    var dmBackBtn = document.getElementById('dm-back-btn');
    var dmPartner = null;
    var dmReturnTo = 'wall';
    var dmPollTimer = null;
    var dmLastMessageId = null;

    var messagesBackBtn = document.getElementById('messages-back-btn');
    var messagesListEl = document.getElementById('messages-list');
    var unreadPollTimer = null;

    var mode = 'register';

    function showError(m, f) {
        errorEl.textContent = m;
        errorEl.classList.add('visible');
        if (f) { f.classList.add('invalid'); f.focus(); }
    }
    function clearErrors() {
        errorEl.textContent = '';
        errorEl.classList.remove('visible');
        var inv = form.querySelectorAll('.invalid');
        for (var i = 0; i < inv.length; i++) inv[i].classList.remove('invalid');
    }
    function getInitial(n) { return n ? n.charAt(0).toUpperCase() : '?'; }
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function avatarHTML(u) {
        if (u && u.avatar) return '<img src="' + u.avatar + '" alt="">';
        return getInitial(u ? (u.username || u.name) : '');
    }
    function formatTime(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        if (d.toDateString() === now.toDateString()) {
            return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
        }
        return d.toLocaleDateString('ru-RU');
    }
    function bindSwitch() {
        var el = document.getElementById('switch-mode');
        if (!el) return;
        el.addEventListener('click', toggleMode);
    }

    function showPage(name) {
        var pages = [pageAuth, pageHome, pageProfile, pagePeople, pageFriends, pageFeed, pageWall, pageDm, pageMessages, pageChannel, pageGroupChat];
        var navs = [navHome, navFeed, navPeople, navFriends, navWall, navMessages];
        pages.forEach(function (p) { if (p) p.classList.remove('active'); });
        navs.forEach(function (n) { if (n) n.classList.remove('active'); });

        if (name !== 'dm') stopDmPolling();
        if (name !== 'channel') channelMessageForm && channelMessageForm.classList.remove('hidden');

        if (name === 'auth') {
            pageAuth.classList.add('active');
            mainNav.classList.add('hidden');
            fabCreate.classList.add('hidden');
            createMenu.classList.add('hidden');
            return;
        }
        fabCreate.classList.remove('hidden');
        mainNav.classList.remove('hidden');
        if (name === 'home') { pageHome.classList.add('active'); navHome.classList.add('active'); }
        else if (name === 'profile') pageProfile.classList.add('active');
        else if (name === 'people') { pagePeople.classList.add('active'); navPeople.classList.add('active'); }
        else if (name === 'friends') { pageFriends.classList.add('active'); navFriends.classList.add('active'); }
        else if (name === 'feed') { pageFeed.classList.add('active'); navFeed.classList.add('active'); }
        else if (name === 'wall') { pageWall.classList.add('active'); navWall.classList.add('active'); }
        else if (name === 'dm') pageDm.classList.add('active');
        else if (name === 'channel') pageChannel.classList.add('active');
        else if (name === 'groupchat') pageGroupChat.classList.add('active');
        else if (name === 'messages') { pageMessages.classList.add('active'); navMessages.classList.add('active'); }
    }

    function setMode(m) {
        mode = m;
        clearErrors();
        form.reset();
        if (mode === 'register') {
            usernameInput.classList.remove('hidden');
            emailInput.placeholder = currentLang === 'ru' ? 'Почта' : 'Email';
            password2Wrapper.classList.remove('hidden');
            orDivider.classList.remove('hidden');
            socialBlock.classList.remove('hidden');
        } else {
            usernameInput.classList.add('hidden');
            emailInput.placeholder = currentLang === 'ru' ? 'Имя или почта' : 'Username or email';
            password2Wrapper.classList.add('hidden');
            orDivider.classList.add('hidden');
            socialBlock.classList.add('hidden');
        }
        applyLanguage();
    }
    function toggleMode() { setMode(mode === 'register' ? 'login' : 'register'); }

    function updateHeader(u) {
        if (u) {
            headerLoginBtn.classList.add('hidden');
            headerUser.classList.remove('hidden');
            headerAvatar.innerHTML = avatarHTML(u);
            headerUsername.textContent = u.username;
        } else {
            headerLoginBtn.classList.remove('hidden');
            headerUser.classList.add('hidden');
        }
    }
    function updateHome(u) {
        homeAvatar.innerHTML = avatarHTML(u);
        homeTitle.textContent = (currentLang === 'ru' ? 'Привет, ' : 'Hello, ') + u.username + '!';
        homeText.textContent = currentLang === 'ru' ? 'Рад видеть тебя в Hot' : 'Welcome to Hot';
    }
    function updateProfile(u) {
        profileAvatarPreview.innerHTML = avatarHTML(u);
        profileUsername.value = u.username;
        profileHandle.value = u.handle || '';
        profileEmail.value = u.email;
        pendingAvatar = null;
    }

    function resizeImage(file, cb) {
        var r = new FileReader();
        r.onload = function (e) {
            var img = new Image();
            img.onload = function () {
                var c = document.createElement('canvas');
                c.width = AVATAR_DIMENSION; c.height = AVATAR_DIMENSION;
                var ctx = c.getContext('2d');
                var min = Math.min(img.width, img.height);
                ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, AVATAR_DIMENSION, AVATAR_DIMENSION);
                cb(c.toDataURL('image/jpeg', 0.85));
            };
            img.onerror = function () { cb(null); };
            img.src = e.target.result;
        };
        r.onerror = function () { cb(null); };
        r.readAsDataURL(file);
    }
    function resizeImageFit(file, maxDim, cb) {
        var r = new FileReader();
        r.onload = function (e) {
            var img = new Image();
            img.onload = function () {
                var w = img.width, h = img.height;
                var scale = Math.min(1, maxDim / Math.max(w, h));
                var cw = Math.max(1, Math.round(w * scale));
                var ch = Math.max(1, Math.round(h * scale));
                var c = document.createElement('canvas');
                c.width = cw; c.height = ch;
                var ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0, cw, ch);
                cb(c.toDataURL('image/jpeg', 0.85));
            };
            img.onerror = function () { cb(null); };
            img.src = e.target.result;
        };
        r.onerror = function () { cb(null); };
        r.readAsDataURL(file);
    }

    /* ---------- РЕНДЕР ПОСТОВ ---------- */
    function renderPostActions(p) {
        var likes = Array.isArray(p.likes) ? p.likes : [];
        var comments = Array.isArray(p.comments) ? p.comments : [];
        var liked = currentUser && likes.some(function (u) {
            return u.toLowerCase() === currentUser.username.toLowerCase();
        });
        var reposted = !!p.repostedByViewer;
        var repostId = p.repostOf && p.repostOf.id ? p.repostOf.id : p.id;
        var t = I18N[currentLang];
        return '<div class="post-actions">'
            + '<button type="button" class="post-action-btn' + (liked ? ' liked' : '') + '" data-action="like" data-id="' + escapeHtml(p.id) + '">'
            +   '<span>❤</span><span class="like-count">' + likes.length + '</span>'
            + '</button>'
            + '<button type="button" class="post-action-btn" data-action="comment" data-id="' + escapeHtml(p.id) + '">'
            +   '<span>💬</span><span>' + comments.length + '</span>'
            + '</button>'
            + '<button type="button" class="post-action-btn' + (reposted ? ' reposted' : '') + '" data-action="repost" data-id="' + escapeHtml(repostId) + '">'
            +   '<span>🔁</span><span class="repost-label-text">' + (reposted ? t.reposted : t.repost) + '</span>'
            + '</button>'
            + '</div>'
            + '<div class="post-comments" data-comments-for="' + escapeHtml(p.id) + '"></div>';
    }

    function renderPost(p) {
        var date = p.createdAt ? new Date(p.createdAt).toLocaleString('ru-RU') : '';
        var html = '<div class="wall-post" data-post-id="' + escapeHtml(p.id) + '">';

        if (p.repostOf) {
            html += '<div class="repost-label">🔁 ' + (currentLang==='ru'?'Репост от ':'Repost from ') + '<b>' + escapeHtml(p.username) + '</b></div>';
            html += '<div class="repost-block">'
                + '<div class="repost-block-head">'
                +   '<div class="repost-block-avatar">' + (p.repostOf.avatar ? '<img src="' + p.repostOf.avatar + '" alt="">' : getInitial(p.repostOf.username)) + '</div>'
                +   '<div><div class="repost-block-author">' + escapeHtml(p.repostOf.username) + '</div>'
                +   '<div class="repost-block-date">' + new Date(p.repostOf.createdAt).toLocaleString('ru-RU') + '</div></div>'
                + '</div>';
            if (p.repostOf.text) html += '<div class="repost-block-text">' + escapeHtml(p.repostOf.text) + '</div>';
            if (p.repostOf.image) html += '<div class="repost-block-image"><img src="' + p.repostOf.image + '" alt=""></div>';
            html += '</div>';
        } else {
            html += '<div class="wall-post-head">'
                + '<div class="wall-post-avatar">' + avatarHTML(p) + '</div>'
                + '<div><div class="wall-post-author" data-username="' + escapeHtml(p.username) + '">' + escapeHtml(p.username) + '</div>'
                + '<div class="wall-post-date">' + date + '</div></div>'
                + '</div>';
            if (p.text) html += '<div class="wall-post-text">' + escapeHtml(p.text) + '</div>';
            if (p.image) html += '<div class="wall-post-image"><img src="' + p.image + '" alt=""></div>';
        }

        html += renderPostActions(p);
        html += '</div>';
        return html;
    }

    function renderPosts(container, posts) {
        if (!posts || posts.length === 0) {
            container.innerHTML = '<p class="chat-empty">' + (currentLang==='ru'?'Пока нет постов':'No posts yet') + '</p>';
            return;
        }
        var html = '';
        for (var i = 0; i < posts.length; i++) html += renderPost(posts[i]);
        container.innerHTML = html;
        bindPostEvents(container);
    }

    function bindPostEvents(container) {
        var buttons = container.querySelectorAll('.post-action-btn');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].addEventListener('click', handlePostAction);
        }
        var authors = container.querySelectorAll('.wall-post-author');
        for (var j = 0; j < authors.length; j++) {
            authors[j].addEventListener('click', function (e) {
                var u = e.currentTarget.getAttribute('data-username');
                if (u) openWall(u);
            });
        }
    }

    function handlePostAction(e) {
        var btn = e.currentTarget;
        var action = btn.getAttribute('data-action');
        var id = btn.getAttribute('data-id');
        if (!id) return;

        if (action === 'like') {
            if (!currentUser) return;
            btn.disabled = true;
            apiPost('/api/posts/like', { id: id, username: currentUser.username })
                .then(function (data) {
                    var countEl = btn.querySelector('.like-count');
                    if (countEl) countEl.textContent = data.likes.length;
                    if (data.liked) btn.classList.add('liked');
                    else btn.classList.remove('liked');
                }).catch(function () {})
                .then(function () { btn.disabled = false; });
        } else if (action === 'comment') {
            toggleComments(id, btn);
        } else if (action === 'repost') {
            if (!currentUser) return;
            btn.disabled = true;
            apiPost('/api/posts/repost', { id: id, username: currentUser.username })
                .then(function (data) {
                    var textEl = btn.querySelector('.repost-label-text');
                    var t = I18N[currentLang];
                    if (data.reposted) {
                        btn.classList.add('reposted');
                        if (textEl) textEl.textContent = t.reposted;
                    } else {
                        btn.classList.remove('reposted');
                        if (textEl) textEl.textContent = t.repost;
                    }
                }).catch(function (err) {
                    alert(err.message || 'Ошибка репоста');
                }).then(function () { btn.disabled = false; });
        }
    }

    function toggleComments(postId, btn) {
        var container = document.querySelector('.post-comments[data-comments-for="' + postId + '"]');
        if (!container) return;
        if (container.classList.contains('open')) {
            container.classList.remove('open');
            return;
        }
        container.classList.add('open');
        container.innerHTML = '<p style="color:#9aa4c7;font-size:13px;padding:6px 0;">...</p>';

        apiGet('/api/posts/comments?id=' + encodeURIComponent(postId)).then(function (data) {
            renderComments(container, postId, data.comments || []);
        }).catch(function () {
            container.innerHTML = '<p style="color:#ff4d6d;font-size:13px;">Error</p>';
        });
    }

    function renderComments(container, postId, comments) {
        var html = '';
        if (comments.length === 0) {
            html += '<p style="color:#9aa4c7;font-size:13px;padding:6px 0;">' + (currentLang==='ru'?'Пока нет комментариев':'No comments yet') + '</p>';
        } else {
            for (var i = 0; i < comments.length; i++) {
                var c = comments[i];
                html += '<div class="comment">'
                    + '<div class="comment-avatar">' + (c.avatar ? '<img src="' + c.avatar + '" alt="">' : getInitial(c.username)) + '</div>'
                    + '<div class="comment-body">'
                    + '<div class="comment-meta"><b data-username="' + escapeHtml(c.username) + '">' + escapeHtml(c.username) + '</b> · ' + formatTime(c.createdAt) + '</div>'
                    + '<div class="comment-text">' + escapeHtml(c.text) + '</div>'
                    + '</div></div>';
            }
        }
        html += '<form class="comment-form" data-post-id="' + escapeHtml(postId) + '">'
            + '<input class="input" type="text" placeholder="' + (currentLang==='ru'?'Написать комментарий...':'Write a comment...') + '" maxlength="1000">'
            + '<button type="submit" class="btn-upload">' + (currentLang==='ru'?'Отправить':'Send') + '</button>'
            + '</form>';
        container.innerHTML = html;

        var f = container.querySelector('.comment-form');
        if (f) f.addEventListener('submit', function (e) {
            e.preventDefault();
            if (!currentUser) return;
            var input = f.querySelector('input');
            var text = input.value.trim();
            if (!text) return;
            var sBtn = f.querySelector('button');
            sBtn.disabled = true;
            apiPost('/api/posts/comment', { id: postId, username: currentUser.username, text: text })
                .then(function (data) {
                    input.value = '';
                    renderComments(container, postId, data.comments || []);
                }).catch(function (err) {
                    alert(err.message || 'Ошибка');
                }).then(function () { sBtn.disabled = false; });
        });

        var names = container.querySelectorAll('.comment-meta b');
        for (var k = 0; k < names.length; k++) {
            names[k].addEventListener('click', function (e) {
                var u = e.currentTarget.getAttribute('data-username');
                if (u) openWall(u);
            });
        }
    }

    function openFeed() {
        if (!currentUser) return;
        showPage('feed');
        loadFeed();
    }

    function loadFeed() {
        feedPostsEl.innerHTML = '<p style="color:#9aa4c7;">...</p>';
        apiGet('/api/posts/feed?viewer=' + encodeURIComponent(currentUser.username)).then(function (data) {
            renderPosts(feedPostsEl, data.posts || []);
        }).catch(function () {
            feedPostsEl.innerHTML = '<p style="color:#ff4d6d;">Error</p>';
        });
    }

    /* ---------- СТРАНИЦА ПРОФИЛЯ (СТЕНА) И ДРУЗЬЯ ---------- */
    function openWall(username) {
        if (!currentUser || !username) return;
        wallViewingUsername = username;
        showPage('wall');
        loadWallProfile(username);
    }

    function renderWallProfileHeader(user, isOwn) {
        var handleLine = user.handle ? '@' + escapeHtml(user.handle) : '';
        var t = I18N[currentLang];

        var html = '<div class="wall-profile-avatar">' + avatarHTML(user) + '</div>'
            + '<div class="wall-profile-meta">'
            + '<div class="wall-profile-name">' + escapeHtml(user.username) + '</div>'
            + (handleLine ? '<div class="wall-profile-handle">' + handleLine + '</div>' : '')
            + '</div>';
        
        if (!isOwn) {
            html += '<div class="wall-profile-actions" id="wall-actions-container">'
                + '<button type="button" class="btn-upload wall-message-btn" id="wall-message-btn">' + t.writeMsg + '</button>'
                + '</div>';
        }
        wallProfileHeader.innerHTML = html;

        if (!isOwn) {
            var msgBtn = document.getElementById('wall-message-btn');
            if (msgBtn) msgBtn.addEventListener('click', function () { openDm(user); });

            // Загружаем точный статус дружбы/заявки
            apiGet('/api/friends/status?me=' + encodeURIComponent(currentUser.username) + '&target=' + encodeURIComponent(user.username))
                .then(function(res) {
                    var container = document.getElementById('wall-actions-container');
                    if (!container) return;

                    var frBtnHtml = '';
                    if (res.status === 'friends') {
                        frBtnHtml = '<button type="button" class="btn-remove" id="wall-friend-btn">' + t.removeFriend + '</button>';
                    } else if (res.status === 'sent') {
                        frBtnHtml = '<button type="button" class="btn-secondary" id="wall-friend-btn" style="border-color:var(--accent-1);color:var(--accent-1);">' + t.reqSent + '</button>';
                    } else if (res.status === 'received') {
                        frBtnHtml = '<button type="button" class="btn-upload" id="wall-accept-btn">' + t.accept + '</button>'
                                  + '<button type="button" class="btn-secondary" id="wall-decline-btn">' + t.decline + '</button>';
                    } else {
                        frBtnHtml = '<button type="button" class="btn-upload" id="wall-friend-btn">' + t.addFriend + '</button>';
                    }

                    container.insertAdjacentHTML('afterbegin', frBtnHtml);

                    var frBtn = document.getElementById('wall-friend-btn');
                    if (frBtn) {
                        frBtn.addEventListener('click', function() {
                            var act = 'send';
                            if (res.status === 'friends') act = 'remove';
                            else if (res.status === 'sent') act = 'cancel';

                            apiPost('/api/friends/action', { me: currentUser.username, target: user.username, action: act })
                                .then(function() {
                                    loadWallProfile(user.username);
                                    updateFriendRequestsBadge();
                                });
                        });
                    }

                    var accBtn = document.getElementById('wall-accept-btn');
                    var decBtn = document.getElementById('wall-decline-btn');
                    if (accBtn) {
                        accBtn.addEventListener('click', function() {
                            apiPost('/api/friends/action', { me: currentUser.username, target: user.username, action: 'accept' })
                                .then(function() {
                                    loadWallProfile(user.username);
                                    updateFriendRequestsBadge();
                                });
                        });
                    }
                    if (decBtn) {
                        decBtn.addEventListener('click', function() {
                            apiPost('/api/friends/action', { me: currentUser.username, target: user.username, action: 'decline' })
                                .then(function() {
                                    loadWallProfile(user.username);
                                    updateFriendRequestsBadge();
                                });
                        });
                    }
                });
        }
    }

    function loadWallFriends(username) {
        apiGet('/api/friends?username=' + encodeURIComponent(username)).then(function(res) {
            var list = res.friends || [];
            wallFriendsBox.classList.remove('hidden');
            wallFriendsCount.textContent = list.length;
            if (!list.length) {
                wallFriendsList.innerHTML = '<span style="font-size:12px;color:var(--text-muted);">' + I18N[currentLang].noFriends + '</span>';
                return;
            }
            var html = '';
            list.forEach(function(f) {
                html += '<div class="wall-friend-mini" data-username="' + escapeHtml(f.username) + '">'
                    + '<div class="user-avatar">' + avatarHTML(f) + '</div>'
                    + '<span>' + escapeHtml(f.username) + '</span>'
                    + '</div>';
            });
            wallFriendsList.innerHTML = html;
            wallFriendsList.querySelectorAll('.wall-friend-mini').forEach(function(el) {
                el.addEventListener('click', function() {
                    openWall(el.getAttribute('data-username'));
                });
            });
        });
    }

    function loadWallProfile(username) {
        wallProfileHeader.innerHTML = '<p style="color:#9aa4c7;">...</p>';
        wallPostsEl.innerHTML = '';
        wallPostForm.classList.add('hidden');
        wallFriendsBox.classList.add('hidden');

        apiGet('/api/users').then(function (data) {
            var users = data.users || [];
            var user = users.find(function(u) { return u.username.toLowerCase() === username.toLowerCase(); });
            if (!user) {
                wallProfileHeader.innerHTML = '<p style="color:#ff4d6d;">User not found</p>';
                return;
            }
            var isOwn = !!(currentUser && user.username.toLowerCase() === currentUser.username.toLowerCase());
            renderWallProfileHeader(user, isOwn);
            loadWallFriends(user.username);

            if (isOwn) {
                wallPostForm.classList.remove('hidden');
                wallPostText.value = '';
                pendingWallImage = '';
                wallPostImagePreview.innerHTML = '';
                wallPostImageInput.value = '';
                wallPostError.classList.remove('visible');
            }
            loadWallPosts(user.username);
        }).catch(function () {
            wallProfileHeader.innerHTML = '<p style="color:#ff4d6d;">Error</p>';
        });
    }

    function loadWallPosts(username) {
        wallPostsEl.innerHTML = '<p style="color:#9aa4c7;">...</p>';
        apiGet('/api/posts?username=' + encodeURIComponent(username) + '&viewer=' + encodeURIComponent(currentUser.username)).then(function (data) {
            renderPosts(wallPostsEl, data.posts || []);
        }).catch(function () {
            wallPostsEl.innerHTML = '<p style="color:#ff4d6d;">Error</p>';
        });
    }

    /* ---------- ПОИСК В ШАПКЕ С ТОЧНЫМ СОВПАДЕНИЕМ ---------- */
    var globalSearchInput = document.getElementById('global-search-input');
    var globalSearchDropdown = document.getElementById('global-search-dropdown');

    globalSearchInput.addEventListener('input', function() {
        var q = globalSearchInput.value.trim().toLowerCase().replace(/^@+/, '');
        if (!q) {
            globalSearchDropdown.classList.add('hidden');
            return;
        }

        Promise.all([
            apiGet('/api/users/search?q=' + encodeURIComponent(q)),
            apiGet('/api/channels/search?q=' + encodeURIComponent(q))
        ]).then(function(res) {
            var users = res[0].users || [];
            var channels = res[1].channels || [];

            function sortMatches(list, key1, key2) {
                return list.sort(function(a, b) {
                    var aExact = (a[key1] && a[key1].toLowerCase() === q) || (a[key2] && a[key2].toLowerCase() === q);
                    var bExact = (b[key1] && b[key1].toLowerCase() === q) || (b[key2] && b[key2].toLowerCase() === q);
                    if (aExact && !bExact) return -1;
                    if (!aExact && bExact) return 1;
                    return 0;
                });
            }

            users = sortMatches(users, 'username', 'handle');
            channels = sortMatches(channels, 'username', 'name');

            if (!users.length && !channels.length) {
                globalSearchDropdown.innerHTML = '<p class="chat-empty" style="padding:10px;">Ничего не найдено</p>';
                globalSearchDropdown.classList.remove('hidden');
                return;
            }

            var html = '';
            users.forEach(function(u) {
                var isExact = (u.username && u.username.toLowerCase() === q) || (u.handle && u.handle.toLowerCase() === q);
                html += '<div class="global-search-item" data-type="user" data-id="' + escapeHtml(u.username) + '">'
                    + '<div class="user-avatar" style="width:34px;height:34px;font-size:14px;">' + avatarHTML(u) + '</div>'
                    + '<div><div style="font-weight:600;font-size:14px;">' + escapeHtml(u.username) + '</div>'
                    + (u.handle ? '<div style="font-size:12px;color:var(--text-muted);">@' + escapeHtml(u.handle) + '</div>' : '') + '</div>'
                    + (isExact ? '<span class="exact-match-badge">' + I18N[currentLang].exactMatch + '</span>' : '')
                    + '</div>';
            });

            channels.forEach(function(c) {
                var isExact = (c.username && c.username.toLowerCase() === q) || (c.name && c.name.toLowerCase() === q);
                html += '<div class="global-search-item" data-type="channel" data-id="' + escapeHtml(c.username) + '">'
                    + '<div class="user-avatar" style="width:34px;height:34px;font-size:14px;">' + (c.avatar ? '<img src="'+c.avatar+'">' : '📢') + '</div>'
                    + '<div><div style="font-weight:600;font-size:14px;">' + escapeHtml(c.name) + '</div>'
                    + '<div style="font-size:12px;color:var(--text-muted);">@' + escapeHtml(c.username) + '</div></div>'
                    + (isExact ? '<span class="exact-match-badge">' + I18N[currentLang].exactMatch + '</span>' : '')
                    + '</div>';
            });

            globalSearchDropdown.innerHTML = html;
            globalSearchDropdown.classList.remove('hidden');

            globalSearchDropdown.querySelectorAll('.global-search-item').forEach(function(item) {
                item.addEventListener('click', function() {
                    var type = item.getAttribute('data-type');
                    var id = item.getAttribute('data-id');
                    globalSearchDropdown.classList.add('hidden');
                    globalSearchInput.value = '';
                    if (type === 'user') openWall(id);
                    else if (type === 'channel') openChannel(id);
                });
            });
        });
    });

    document.addEventListener('click', function(e) {
        if (!globalSearchInput.contains(e.target) && !globalSearchDropdown.contains(e.target)) {
            globalSearchDropdown.classList.add('hidden');
        }
    });

    /* ---------- КАНАЛЫ (РЕАКЦИИ, АВАТАРКА, НАСТРОЙКИ, ПОСТИНГ ОТ КАНАЛА) ---------- */
    function openChannel(username) {
        if (!currentUser || !username) return;
        activeChannelUsername = username;
        showPage('channel');
        loadChannel();
    }

    function renderChannelMessages(messages) {
        if (!messages || !messages.length) {
            channelMessagesEl.innerHTML = '<p class="chat-empty">' + (currentLang==='ru'?'В канале пока нет сообщений':'No messages yet') + '</p>';
            return;
        }
        var html = '';
        for (var i = 0; i < messages.length; i++) {
            var m = messages[i];
            var reactions = m.reactions || { like: [], fire: [], demon: [] };
            var myLike = currentUser && (reactions.like || []).some(function(u){ return u.toLowerCase() === currentUser.username.toLowerCase(); });
            var myFire = currentUser && (reactions.fire || []).some(function(u){ return u.toLowerCase() === currentUser.username.toLowerCase(); });
            var myDemon = currentUser && (reactions.demon || []).some(function(u){ return u.toLowerCase() === currentUser.username.toLowerCase(); });

            var avHtml = m.channelAvatar ? '<img src="' + m.channelAvatar + '">' : '📢';

            html += '<div class="chat-msg" data-msg-id="' + escapeHtml(m.id) + '">'
                + '<div class="chat-msg-avatar">' + avHtml + '</div>'
                + '<div class="chat-msg-body">'
                + '<div class="chat-msg-meta">' + escapeHtml(m.from) + ' · ' + formatTime(m.createdAt) + '</div>'
                + '<div class="chat-msg-bubble">' + escapeHtml(m.text) + '</div>'
                + '<div class="channel-reactions">'
                +   '<button type="button" class="reaction-btn' + (myLike ? ' active' : '') + '" data-react="like">👍 <span>' + (reactions.like ? reactions.like.length : 0) + '</span></button>'
                +   '<button type="button" class="reaction-btn' + (myFire ? ' active' : '') + '" data-react="fire">🔥 <span>' + (reactions.fire ? reactions.fire.length : 0) + '</span></button>'
                +   '<button type="button" class="reaction-btn' + (myDemon ? ' active' : '') + '" data-react="demon">😈 <span>' + (reactions.demon ? reactions.demon.length : 0) + '</span></button>'
                + '</div>'
                + '</div></div>';
        }
        channelMessagesEl.innerHTML = html;
        channelMessagesEl.scrollTop = channelMessagesEl.scrollHeight;

        channelMessagesEl.querySelectorAll('.reaction-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                if (!currentUser) return;
                var msgRow = btn.closest('.chat-msg');
                var mId = msgRow.getAttribute('data-msg-id');
                var reactType = btn.getAttribute('data-react');
                apiPost('/api/channels/message/reaction', {
                    channel: activeChannelUsername,
                    messageId: mId,
                    username: currentUser.username,
                    type: reactType
                }).then(function() {
                    loadChannel(true);
                });
            });
        });
    }

    function loadChannel(silent) {
        apiGet('/api/channels?username=' + encodeURIComponent(activeChannelUsername) + '&viewer=' + encodeURIComponent(currentUser ? currentUser.username : ''))
            .then(function(d) {
                var c = d.channel;
                currentChannelData = c;
                var isOwner = currentUser && c.owner.toLowerCase() === currentUser.username.toLowerCase();
                var subText = c.isSubscribed ? I18N[currentLang].unsubscribe : I18N[currentLang].subscribe;
                var subBtnHtml = !isOwner
                    ? '<button type="button" class="btn-upload" id="channel-sub-btn" style="margin-top:10px;">' + subText + '</button>'
                    : '';

                channelSettingsBtn.classList.toggle('hidden', !isOwner);

                var avHtml = c.avatar ? '<img src="' + c.avatar + '" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">' : '<span style="font-size:32px;">📢</span>';

                channelPageInfo.innerHTML = '<div style="display:flex;align-items:center;gap:15px;">'
                    + avHtml
                    + '<div>'
                    + '<div class="wall-profile-name">' + escapeHtml(c.name) + '</div>'
                    + '<div class="wall-profile-handle">@' + escapeHtml(c.username) + ' · <span id="ch-sub-count">' + c.members + '</span> ' + (currentLang==='ru'?'подписчиков':'subscribers') + '</div>'
                    + '<div style="color:#9aa4c7;font-size:13px;margin-top:4px;">' + escapeHtml(c.description || '') + '</div>'
                    + subBtnHtml
                    + '</div></div>';

                var subBtn = document.getElementById('channel-sub-btn');
                if (subBtn) {
                    subBtn.addEventListener('click', function() {
                        apiPost('/api/channels/subscribe', { channel: c.username, username: currentUser.username })
                            .then(function(res) {
                                subBtn.textContent = res.subscribed ? I18N[currentLang].unsubscribe : I18N[currentLang].subscribe;
                                document.getElementById('ch-sub-count').textContent = res.memberCount;
                            });
                    });
                }

                return apiGet('/api/channels/messages?username=' + encodeURIComponent(c.username)).then(function(m) {
                    renderChannelMessages(m.messages || []);
                    channelMessageForm.classList.toggle('hidden', !isOwner);
                });
            }).catch(function(e) {
                if (!silent) channelMessagesEl.innerHTML = '<p class="chat-empty" style="color:#ff4d6d;">' + escapeHtml(e.message) + '</p>';
            });
    }

    /* Настройки канала */
    channelSettingsBtn.addEventListener('click', function() {
        if (!currentChannelData) return;
        channelEditError.classList.remove('visible');
        channelEditName.value = currentChannelData.name;
        channelEditUsername.value = currentChannelData.username;
        channelEditDescription.value = currentChannelData.description || '';
        pendingChannelAvatar = null;
        channelEditAvatarPreview.innerHTML = currentChannelData.avatar ? '<img src="' + currentChannelData.avatar + '" style="width:100%;height:100%;object-fit:cover;">' : '📢';
        channelEditModal.classList.remove('hidden');
    });
    document.getElementById('channel-edit-cancel').addEventListener('click', function() {
        channelEditModal.classList.add('hidden');
    });

    channelAvatarInput.addEventListener('change', function(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        resizeImage(file, function(dataURL) {
            if (!dataURL) return;
            pendingChannelAvatar = dataURL;
            channelEditAvatarPreview.innerHTML = '<img src="' + dataURL + '" style="width:100%;height:100%;object-fit:cover;">';
        });
    });

    document.getElementById('channel-edit-save').addEventListener('click', function() {
        if (!currentUser || !currentChannelData) return;
        channelEditError.classList.remove('visible');
        var payload = {
            originalUsername: currentChannelData.username,
            owner: currentUser.username,
            name: channelEditName.value.trim(),
            username: channelEditUsername.value.trim(),
            description: channelEditDescription.value.trim()
        };
        if (pendingChannelAvatar !== null) payload.avatar = pendingChannelAvatar;

        apiPost('/api/channels/update', payload).then(function(res) {
            channelEditModal.classList.add('hidden');
            activeChannelUsername = res.channel.username;
            loadChannel();
        }).catch(function(e) {
            channelEditError.textContent = e.message;
            channelEditError.classList.add('visible');
        });
    });

    /* ---------- ГРУППОВЫЕ ЧАТЫ И СООБЩЕНИЯ ---------- */
    function openGroupChat(id, returnTo) { if (!currentUser) return; activeGroupChatId=id; groupChatReturnTo=returnTo||'messages'; showPage('groupchat'); loadGroupChat(); }
    function renderGroupMessages(messages) {
        if (!messages || !messages.length) { groupchatMessagesEl.innerHTML='<p class="chat-empty">Напиши первое сообщение</p>'; return; }
        var html=''; for(var i=0;i<messages.length;i++){var m=messages[i];var own=currentUser&&m.from.toLowerCase()===currentUser.username.toLowerCase();html+='<div class="chat-msg '+(own?'own':'')+'"><div class="chat-msg-avatar">'+getInitial(m.from)+'</div><div class="chat-msg-body"><div class="chat-msg-meta">'+escapeHtml(m.from)+' · '+formatTime(m.createdAt)+'</div><div class="chat-msg-bubble">'+escapeHtml(m.text)+'</div></div></div>';}
        groupchatMessagesEl.innerHTML=html; groupchatMessagesEl.scrollTop=groupchatMessagesEl.scrollHeight;
    }
    function loadGroupChat() { apiGet('/api/chats/messages?id='+encodeURIComponent(activeGroupChatId)+'&user='+encodeURIComponent(currentUser.username)).then(function(d){ groupchatInfo.innerHTML='<div><div class="wall-profile-name">💬 '+escapeHtml(d.chat.name)+'</div><div class="wall-profile-handle">'+d.chat.memberCount+' участников</div></div>'; renderGroupMessages(d.messages||[]); }).catch(function(e){groupchatMessagesEl.innerHTML='<p class="chat-empty" style="color:#ff4d6d;">'+escapeHtml(e.message)+'</p>';}); }

    function openDm(user, returnTo) {
        if (!currentUser || !user) return;
        dmPartner = user;
        dmReturnTo = returnTo || 'wall';
        showPage('dm');
        renderDmHeader();
        startDmPolling();
    }

    function renderDmHeader() {
        if (!dmPartner) return;
        var handleLine = dmPartner.handle ? '@' + escapeHtml(dmPartner.handle) : '';
        dmPartnerInfo.innerHTML = '<div style="display:flex;align-items:center;gap:12px;"><div class="wall-profile-avatar" style="width:44px;height:44px;">' + avatarHTML(dmPartner) + '</div>'
            + '<div><div class="wall-profile-name" style="font-size:16px;">' + escapeHtml(dmPartner.username) + '</div>'
            + (handleLine ? '<div class="wall-profile-handle">' + handleLine + '</div>' : '') + '</div></div>';
    }

    function renderDmMessages(messages) {
        if (!messages || messages.length === 0) {
            dmMessagesEl.innerHTML = '<p class="chat-empty">' + (currentLang==='ru'?'Напиши первое сообщение':'Send the first message') + '</p>';
            return;
        }
        var nearBottom = dmMessagesEl.scrollTop + dmMessagesEl.clientHeight >= dmMessagesEl.scrollHeight - 60;
        var html = '';
        for (var i = 0; i < messages.length; i++) {
            var m = messages[i];
            var own = !!(currentUser && m.from.toLowerCase() === currentUser.username.toLowerCase());
            var authorUser = own ? currentUser : dmPartner;
            html += '<div class="chat-msg' + (own ? ' own' : '') + '">'
                + '<div class="chat-msg-avatar">' + avatarHTML(authorUser) + '</div>'
                + '<div class="chat-msg-body">'
                + '<div class="chat-msg-meta">' + formatTime(m.createdAt) + '</div>'
                + '<div class="chat-msg-bubble">' + escapeHtml(m.text) + '</div>'
                + '</div></div>';
        }
        dmMessagesEl.innerHTML = html;
        if (nearBottom) dmMessagesEl.scrollTop = dmMessagesEl.scrollHeight;
    }

    function loadDmMessages(forceScroll) {
        if (!currentUser || !dmPartner) return;
        apiGet('/api/dm?user=' + encodeURIComponent(currentUser.username) + '&with=' + encodeURIComponent(dmPartner.username)).then(function (data) {
            var messages = data.messages || [];
            var newLast = messages.length ? messages[messages.length - 1].id : null;
            if (!forceScroll && newLast === dmLastMessageId) return;
            dmLastMessageId = newLast;
            renderDmMessages(messages);
            if (forceScroll) dmMessagesEl.scrollTop = dmMessagesEl.scrollHeight;
        }).catch(function () {});
    }

    function startDmPolling() {
        stopDmPolling();
        dmLastMessageId = null;
        loadDmMessages(true);
        loadUnreadCount();
        dmPollTimer = setInterval(function () { loadDmMessages(false); }, 3000);
    }
    function stopDmPolling() {
        if (dmPollTimer) { clearInterval(dmPollTimer); dmPollTimer = null; }
    }

    function renderMessagesList(conversations, chats) {
        var html = '';
        if (conversations && conversations.length) {
            for (var i=0;i<conversations.length;i++) {
                var c = conversations[i];
                var isUnread = c.unread > 0;
                var prefix = (currentUser && c.lastFrom && c.lastFrom.toLowerCase() === currentUser.username.toLowerCase()) ? (currentLang==='ru'?'Вы: ':'You: ') : '';
                html += '<div class="message-row' + (isUnread ? ' unread' : '') + '" data-index="' + i + '">'
                    + '<div class="message-row-avatar">' + avatarHTML(c) + '</div>'
                    + '<div class="message-row-body"><div class="message-row-top"><div class="message-row-name">' + escapeHtml(c.username) + '</div><div class="message-row-time">' + formatTime(c.lastAt) + '</div></div>'
                    + '<div class="message-row-preview">' + escapeHtml(prefix + c.lastText) + '</div></div>'
                    + (isUnread ? '<div class="message-row-unread-count">' + (c.unread > 99 ? '99+' : c.unread) + '</div>' : '')
                    + '</div>';
            }
        }
        if (!html) html = '<p class="chat-empty">' + (currentLang==='ru'?'Пока нет сообщений':'No messages yet') + '</p>';
        messagesListEl.innerHTML = html;

        var rows = messagesListEl.querySelectorAll('.message-row');
        for (var j = 0; j < rows.length; j++) {
            rows[j].addEventListener('click', function(e) {
                var idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
                var c = conversations[idx];
                if (c) openDm({ username: c.username, avatar: c.avatar, handle: c.handle }, 'messages');
            });
        }
    }
    function loadMessagesList() {
        if (!currentUser) return;
        messagesListEl.innerHTML = '<p style="color:#9aa4c7;">...</p>';
        Promise.all([
            apiGet('/api/dm/conversations?user=' + encodeURIComponent(currentUser.username)),
            apiGet('/api/chats?user=' + encodeURIComponent(currentUser.username))
        ]).then(function(r) {
            renderMessagesList(r[0].conversations || [], r[1].chats || []);
        });
    }

    function updateUnreadBadge(count) {
        var badges = [navMessagesBadge, homeMessagesBadge];
        for (var i = 0; i < badges.length; i++) {
            if (!badges[i]) continue;
            if (count > 0) {
                badges[i].textContent = count > 99 ? '99+' : String(count);
                badges[i].classList.remove('hidden');
            } else {
                badges[i].classList.add('hidden');
            }
        }
    }

    function loadUnreadCount() {
        if (!currentUser) return;
        apiGet('/api/dm/unread-count?user=' + encodeURIComponent(currentUser.username)).then(function (data) {
            updateUnreadBadge(data.count || 0);
        }).catch(function () {});
    }
    function startUnreadPolling() {
        stopUnreadPolling();
        loadUnreadCount();
        unreadPollTimer = setInterval(loadUnreadCount, 10000);
    }
    function stopUnreadPolling() {
        if (unreadPollTimer) { clearInterval(unreadPollTimer); unreadPollTimer = null; }
        updateUnreadBadge(0);
    }

    /* ---------- БЕЙДЖ ЗАЯВОК В ДРУЗЬЯ ---------- */
    function updateFriendRequestsBadge() {
        if (!currentUser) return;
        apiGet('/api/friends?username=' + encodeURIComponent(currentUser.username)).then(function(res) {
            var count = (res.requests || []).length;
            var badge = document.getElementById('nav-friends-badge');
            if (badge) {
                if (count > 0) {
                    badge.textContent = count > 99 ? '99+' : String(count);
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
        });
    }

    /* ---------- ЛЮДИ И ДРУЗЬЯ (СПИСКИ) ---------- */
    function loadPeople() {
        peopleList.innerHTML = '<p style="color:#9aa4c7;">...</p>';
        apiGet('/api/users').then(function (data) {
            var users = data.users || [];
            if (!users.length) {
                peopleList.innerHTML = '<p class="chat-empty">Никого нет</p>';
                return;
            }
            var html = '';
            for (var i = 0; i < users.length; i++) {
                var u = users[i];
                var av = avatarHTML(u);
                html += '<div class="person-item" data-username="' + escapeHtml(u.username) + '" style="cursor:pointer;"><div class="person-avatar">' + av + '</div>'
                    + '<div class="person-info"><div class="person-name">' + escapeHtml(u.username) + (u.handle ? ' <span style="color:var(--text-muted);font-weight:400;">@' + escapeHtml(u.handle) + '</span>' : '') + '</div></div></div>';
            }
            peopleList.innerHTML = html;
            peopleList.querySelectorAll('.person-item').forEach(function(el) {
                el.addEventListener('click', function() {
                    openWall(el.getAttribute('data-username'));
                });
            });
        });
    }

    function loadFriends() {
        if (!currentUser) return;
        friendsList.innerHTML = '<p style="color:#9aa4c7;">...</p>';
        incomingRequestsList.innerHTML = '';
        var t = I18N[currentLang];

        apiGet('/api/friends?username=' + encodeURIComponent(currentUser.username)).then(function(res) {
            var friends = res.friends || [];
            var requests = res.requests || [];

            // Входящие заявки
            if (requests.length > 0) {
                incomingRequestsSection.classList.remove('hidden');
                var reqHtml = '';
                requests.forEach(function(u) {
                    reqHtml += '<div class="person-item" data-username="' + escapeHtml(u.username) + '">'
                        + '<div class="person-avatar" style="cursor:pointer;">' + avatarHTML(u) + '</div>'
                        + '<div class="person-info" style="cursor:pointer;"><div class="person-name">' + escapeHtml(u.username) + (u.handle ? ' <span style="color:var(--text-muted);font-weight:400;">@' + escapeHtml(u.handle) + '</span>' : '') + '</div></div>'
                        + '<div class="person-actions">'
                        +   '<button type="button" class="btn-upload req-accept-btn" data-target="' + escapeHtml(u.username) + '">' + t.accept + '</button>'
                        +   '<button type="button" class="btn-secondary req-decline-btn" data-target="' + escapeHtml(u.username) + '">' + t.decline + '</button>'
                        + '</div>'
                        + '</div>';
                });
                incomingRequestsList.innerHTML = reqHtml;

                incomingRequestsList.querySelectorAll('.person-avatar, .person-info').forEach(function(el) {
                    el.addEventListener('click', function() {
                        var p = el.closest('.person-item');
                        openWall(p.getAttribute('data-username'));
                    });
                });

                incomingRequestsList.querySelectorAll('.req-accept-btn').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        var target = btn.getAttribute('data-target');
                        apiPost('/api/friends/action', { me: currentUser.username, target: target, action: 'accept' })
                            .then(function() {
                                loadFriends();
                                updateFriendRequestsBadge();
                            });
                    });
                });

                incomingRequestsList.querySelectorAll('.req-decline-btn').forEach(function(btn) {
                    btn.addEventListener('click', function() {
                        var target = btn.getAttribute('data-target');
                        apiPost('/api/friends/action', { me: currentUser.username, target: target, action: 'decline' })
                            .then(function() {
                                loadFriends();
                                updateFriendRequestsBadge();
                            });
                    });
                });
            } else {
                incomingRequestsSection.classList.add('hidden');
            }

            // Список друзей
            if (!friends.length) {
                friendsList.innerHTML = '<p class="chat-empty">' + t.noFriends + '</p>';
                return;
            }
            var html = '';
            friends.forEach(function(u) {
                html += '<div class="person-item" data-username="' + escapeHtml(u.username) + '">'
                    + '<div class="person-avatar" style="cursor:pointer;">' + avatarHTML(u) + '</div>'
                    + '<div class="person-info" style="cursor:pointer;"><div class="person-name">' + escapeHtml(u.username) + (u.handle ? ' <span style="color:var(--text-muted);font-weight:400;">@' + escapeHtml(u.handle) + '</span>' : '') + '</div></div>'
                    + '<div class="person-actions">'
                    +   '<button type="button" class="btn-remove friend-remove-btn" data-target="' + escapeHtml(u.username) + '">' + t.removeFriend + '</button>'
                    + '</div>'
                    + '</div>';
            });
            friendsList.innerHTML = html;

            friendsList.querySelectorAll('.person-avatar, .person-info').forEach(function(el) {
                el.addEventListener('click', function() {
                    var p = el.closest('.person-item');
                    openWall(p.getAttribute('data-username'));
                });
            });

            friendsList.querySelectorAll('.friend-remove-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var target = btn.getAttribute('data-target');
                    apiPost('/api/friends/action', { me: currentUser.username, target: target, action: 'remove' })
                        .then(function() {
                            loadFriends();
                            updateFriendRequestsBadge();
                        });
                });
            });
        });
    }

    /* ---------- АВТОРИЗАЦИЯ И РЕДАКТИРОВАНИЕ ---------- */
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        clearErrors();
        var email = emailInput.value.trim();
        var password = passwordInput.value;

        if (mode === 'register') {
            var username = usernameInput.value.trim();
            var password2 = password2Input.value;
            if (username.length < 3) return showError('Имя — минимум 3 символа', usernameInput);
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('Некорректный email', emailInput);
            if (password.length < 6) return showError('Пароль — минимум 6 символов', passwordInput);
            if (password !== password2) return showError('Пароли не совпадают', password2Input);

            submitBtn.disabled = true;
            apiPost('/api/register', { username: username, email: email, password: password })
                .then(function (u) {
                    currentUser = u;
                    setSession(u.username);
                    saveAccountToStore(u);
                    updateHeader(u); updateHome(u); updateProfile(u);
                    showPage('home');
                    startUnreadPolling();
                    updateFriendRequestsBadge();
                }).catch(function (e) { showError(e.message); })
                .then(function () { submitBtn.disabled = false; });
        } else {
            if (!email) return showError('Введите имя или почту', emailInput);
            if (password.length < 1) return showError('Введите пароль', passwordInput);

            submitBtn.disabled = true;
            apiPost('/api/login', { login: email, password: password })
                .then(function (u) {
                    currentUser = u;
                    setSession(u.username);
                    saveAccountToStore(u);
                    updateHeader(u); updateHome(u); updateProfile(u);
                    showPage('home');
                    startUnreadPolling();
                    updateFriendRequestsBadge();
                }).catch(function (e) { showError(e.message); })
                .then(function () { submitBtn.disabled = false; });
        }
    });

    profileForm.addEventListener('submit', function (e) {
        e.preventDefault();
        profileError.classList.remove('visible');
        profileSuccess.classList.remove('visible');
        if (!currentUser) return;

        var newUsername = profileUsername.value.trim();
        if (newUsername.length < 3 || newUsername.length > 20) {
            profileError.textContent = 'Ник от 3 до 20 символов';
            profileError.classList.add('visible');
            return;
        }
        var newHandle = profileHandle.value.trim().replace(/^@+/, '');
        if (newHandle && !/^[a-zA-Z0-9_]{3,20}$/.test(newHandle)) {
            profileError.textContent = 'Юзернейм: 3-20 символов, латиница, цифры и _';
            profileError.classList.add('visible');
            return;
        }
        var oldName = currentUser.username;
        var payload = { currentUsername: oldName, newUsername: newUsername, handle: newHandle };
        if (pendingAvatar !== null) payload.avatar = pendingAvatar;

        profileSubmitBtn.disabled = true;

        apiPost('/api/update-profile', payload).then(function (u) {
            currentUser = u;
            setSession(u.username);
            saveAccountToStore(u, oldName);
            updateHeader(u); updateHome(u); updateProfile(u);
            profileSuccess.textContent = currentLang === 'ru' ? 'Профиль сохранён!' : 'Profile saved!';
            profileSuccess.classList.add('visible');
            setTimeout(function () { profileSuccess.classList.remove('visible'); }, 2500);
        }).catch(function (e) {
            profileError.textContent = e.message;
            profileError.classList.add('visible');
        }).then(function () {
            profileSubmitBtn.disabled = false;
        });
    });

    avatarInput.addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        if (file.size > MAX_AVATAR_SIZE) {
            profileError.textContent = 'Файл больше 10 МБ';
            profileError.classList.add('visible');
            return;
        }
        resizeImage(file, function (dataURL) {
            if (!dataURL) return;
            pendingAvatar = dataURL;
            profileAvatarPreview.innerHTML = '<img src="' + dataURL + '" alt="">';
        });
    });

    avatarRemoveBtn.addEventListener('click', function () {
        pendingAvatar = '';
        profileAvatarPreview.innerHTML = getInitial(currentUser ? currentUser.username : '?');
    });

    wallPostImageInput.addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        if (file.size > MAX_POST_IMAGE_SIZE) {
            wallPostError.textContent = 'Файл больше 10 МБ';
            wallPostError.classList.add('visible');
            return;
        }
        resizeImageFit(file, POST_IMAGE_MAX_DIM, function (dataURL) {
            if (!dataURL) return;
            pendingWallImage = dataURL;
            wallPostImagePreview.innerHTML = '<img src="' + dataURL + '" alt=""><button type="button" class="wall-image-remove" id="wall-image-remove-btn">✕</button>';
            var rm = document.getElementById('wall-image-remove-btn');
            if (rm) rm.addEventListener('click', function () {
                pendingWallImage = '';
                wallPostImagePreview.innerHTML = '';
                wallPostImageInput.value = '';
            });
        });
    });

    wallPostForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentUser) return;
        var text = wallPostText.value.trim();
        if (!text && !pendingWallImage) {
            wallPostError.textContent = 'Добавь текст или картинку';
            wallPostError.classList.add('visible');
            return;
        }
        wallPostSubmitBtn.disabled = true;
        apiPost('/api/posts', { username: currentUser.username, text: text, image: pendingWallImage })
            .then(function () {
                wallPostText.value = '';
                pendingWallImage = '';
                wallPostImagePreview.innerHTML = '';
                wallPostImageInput.value = '';
                loadWallPosts(currentUser.username);
            })
            .catch(function (e) {
                wallPostError.textContent = e.message;
                wallPostError.classList.add('visible');
            })
            .then(function () { wallPostSubmitBtn.disabled = false; });
    });

    dmForm.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!currentUser || !dmPartner) return;
        var text = dmInput.value.trim();
        if (!text) return;
        dmSendBtn.disabled = true;
        apiPost('/api/dm', { from: currentUser.username, to: dmPartner.username, text: text })
            .then(function () {
                dmInput.value = '';
                loadDmMessages(true);
            })
            .then(function () {
                dmSendBtn.disabled = false;
                dmInput.focus();
            });
    });

    /* ---------- ВЫХОД И КНОПКИ НАВИГАЦИИ ---------- */
    function logout() {
        clearSession();
        currentUser = null;
        wallViewingUsername = null;
        dmPartner = null;
        stopUnreadPolling();
        updateHeader(null);
        setMode('register');
        showPage('auth');
    }

    var logoutConfirmModal = document.getElementById('logout-confirm-modal');
    homeLogoutBtn.addEventListener('click', function () {
        logoutConfirmModal.classList.remove('hidden');
    });
    document.getElementById('logout-confirm-no').addEventListener('click', function () {
        logoutConfirmModal.classList.add('hidden');
    });
    document.getElementById('logout-confirm-yes').addEventListener('click', function () {
        logoutConfirmModal.classList.add('hidden');
        if (currentUser) removeAccountFromStore(currentUser.username);
        var remaining = getAccounts();
        if (remaining.length > 0) {
            switchAccount(remaining[0].username);
        } else {
            logout();
        }
    });

    headerLoginBtn.addEventListener('click', function () { setMode('login'); showPage('auth'); });

    navHome.addEventListener('click', function () { if (currentUser) showPage('home'); });
    navFeed.addEventListener('click', openFeed);
    navPeople.addEventListener('click', function () { if (currentUser) { showPage('people'); loadPeople(); } });
    navFriends.addEventListener('click', function () { if (currentUser) { showPage('friends'); loadFriends(); } });
    navWall.addEventListener('click', function () { if (currentUser) openWall(currentUser.username); });
    navMessages.addEventListener('click', function () { if (currentUser) { showPage('messages'); loadMessagesList(); loadUnreadCount(); } });

    homeWallBtn.addEventListener('click', function () { if (currentUser) openWall(currentUser.username); });
    homeFeedBtn.addEventListener('click', openFeed);
    homeFriendsBtn.addEventListener('click', function () { if (currentUser) { showPage('friends'); loadFriends(); } });
    homeMessagesBtn.addEventListener('click', function () { if (currentUser) { showPage('messages'); loadMessagesList(); loadUnreadCount(); } });

    feedBackBtn.addEventListener('click', function () { showPage('home'); });
    messagesBackBtn.addEventListener('click', function () { showPage('home'); });
    profileBackBtn.addEventListener('click', function () { showPage('home'); });
    wallBackBtn.addEventListener('click', function () { showPage('home'); });

    headerSettingsBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (currentUser) { updateProfile(currentUser); showPage('profile'); }
    });
    headerUser.addEventListener('click', function (e) {
        if (e.target !== accountArrowBtn && !accountDropdown.contains(e.target)) {
            if (currentUser) openWall(currentUser.username);
        }
    });

    dmBackBtn.addEventListener('click', function () {
        loadUnreadCount();
        if (dmReturnTo === 'messages') {
            showPage('messages');
            loadMessagesList();
        } else if (dmPartner) {
            showPage('wall');
            loadWallProfile(dmPartner.username);
        } else {
            showPage('home');
        }
    });

    fabCreate.addEventListener('click', function () { createMenu.classList.toggle('hidden'); });
    document.addEventListener('click', function (e) { if (e.target !== fabCreate && !createMenu.contains(e.target)) createMenu.classList.add('hidden'); });
    document.getElementById('create-channel-btn').addEventListener('click', function(){ createMenu.classList.add('hidden'); channelCreateError.classList.remove('visible'); channelModal.classList.remove('hidden'); channelNameInput.focus(); });
    document.getElementById('channel-cancel-btn').addEventListener('click', function(){ channelModal.classList.add('hidden'); });
    document.getElementById('create-chat-btn').addEventListener('click', function(){ createMenu.classList.add('hidden'); chatCreateError.classList.remove('visible'); chatModal.classList.remove('hidden'); chatNameInput.focus(); });
    document.getElementById('chat-cancel-btn').addEventListener('click', function(){ chatModal.classList.add('hidden'); });
    
    document.getElementById('channel-save-btn').addEventListener('click', function(){
        if(!currentUser) return;
        channelCreateError.classList.remove('visible');
        apiPost('/api/channels',{ owner: currentUser.username, name: channelNameInput.value.trim(), username: channelUsernameInput.value.trim(), description: channelDescriptionInput.value.trim() })
            .then(function(d){ channelModal.classList.add('hidden'); channelNameInput.value=''; channelUsernameInput.value=''; channelDescriptionInput.value=''; openChannel(d.channel.username); })
            .catch(function(e){ channelCreateError.textContent = e.message; channelCreateError.classList.add('visible'); });
    });

    document.getElementById('chat-save-btn').addEventListener('click', function(){
        if(!currentUser) return;
        chatCreateError.classList.remove('visible');
        var members = chatMembersInput.value.split(',').map(function(x){return x.trim();}).filter(Boolean);
        apiPost('/api/chats', { owner: currentUser.username, name: chatNameInput.value.trim(), members: members })
            .then(function(d){ chatModal.classList.add('hidden'); chatNameInput.value=''; chatMembersInput.value=''; openGroupChat(d.chat.id, 'messages'); })
            .catch(function(e){ chatCreateError.textContent = e.message; chatCreateError.classList.add('visible'); });
    });

    channelBackBtn.addEventListener('click', function(){ showPage('wall'); });
    groupchatBackBtn.addEventListener('click', function(){ if(groupChatReturnTo==='messages'){ showPage('messages'); loadMessagesList(); } else showPage('home'); });

    channelMessageForm.addEventListener('submit', function(e){
        e.preventDefault();
        if(!currentUser || !activeChannelUsername) return;
        var text = channelMessageInput.value.trim();
        if(!text) return;
        channelMessageError.classList.remove('visible');
        apiPost('/api/channels/message', { channel: activeChannelUsername, from: currentUser.username, text: text })
            .then(function(){ channelMessageInput.value = ''; loadChannel(true); })
            .catch(function(e){ channelMessageError.textContent = e.message; channelMessageError.classList.add('visible'); });
    });

    groupchatForm.addEventListener('submit', function(e){
        e.preventDefault();
        if(!currentUser || !activeGroupChatId) return;
        var text = groupchatInput.value.trim();
        if(!text) return;
        apiPost('/api/chats/message', { id: activeGroupChatId, from: currentUser.username, text: text })
            .then(function(){ groupchatInput.value = ''; loadGroupChat(); });
    });

    var eyes = document.querySelectorAll('.eye');
    for (var i = 0; i < eyes.length; i++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                var inp = document.getElementById(btn.dataset.target);
                if (!inp) return;
                inp.type = inp.type === 'password' ? 'text' : 'password';
            });
        })(eyes[i]);
    }

    form.addEventListener('input', function (e) {
        if (e.target.classList.contains('invalid')) e.target.classList.remove('invalid');
        if (errorEl.classList.contains('visible')) errorEl.classList.remove('visible');
    });

    function init() {
        applyLanguage();
        var session = getSession();
        if (session) {
            apiGet('/api/users').then(function (data) {
                var found = (data.users || []).find(function(u) { return u.username.toLowerCase() === session.toLowerCase(); });
                if (found) {
                    currentUser = found;
                    saveAccountToStore(found);
                    updateHeader(found); updateHome(found); updateProfile(found);
                    showPage('home');
                    startUnreadPolling();
                    updateFriendRequestsBadge();
                } else {
                    clearSession(); updateHeader(null); setMode('register'); showPage('auth');
                }
            }).catch(function () {
                clearSession(); updateHeader(null); setMode('register'); showPage('auth');
            });
            return;
        }
        updateHeader(null); setMode('register'); showPage('auth');
    }

    setMode('register');
    init();
})();
</script>
</body>
</html>`;

/* ---------- Маршрутизация ---------- */
const server = http.createServer(function (req, res) {
    const parsedUrl = parseUrl(req.url, true);
    const url = parsedUrl.pathname;
    const query = parsedUrl.query;

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
        });
        res.end();
        return;
    }

    if (url === '/api/register' && req.method === 'POST') return handleRegister(req, res);
    if (url === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (url === '/api/users' && req.method === 'GET') return handleUsersList(req, res);
    if (url === '/api/update-profile' && req.method === 'POST') return handleUpdateProfile(req, res);
    if (url === '/api/users/search' && req.method === 'GET') return handleUserSearch(req, res, query);

    // Друзья и заявки
    if (url === '/api/friends/action' && req.method === 'POST') return handleFriendAction(req, res);
    if (url === '/api/friends/status' && req.method === 'GET') return handleFriendStatus(req, res, query);
    if (url === '/api/friends' && req.method === 'GET') return handleFriendsGet(req, res, query);

    // Каналы
    if (url === '/api/channels' && req.method === 'GET') return handleChannelGet(req, res, query);
    if (url === '/api/channels' && req.method === 'POST') return handleChannelCreate(req, res);
    if (url === '/api/channels/update' && req.method === 'POST') return handleChannelUpdate(req, res);
    if (url === '/api/channels/subscribe' && req.method === 'POST') return handleChannelSubscribe(req, res);
    if (url === '/api/channels/search' && req.method === 'GET') return handleChannelSearch(req, res, query);
    if (url === '/api/channels/messages' && req.method === 'GET') return handleChannelMessagesGet(req, res, query);
    if (url === '/api/channels/message' && req.method === 'POST') return handleChannelMessageCreate(req, res);
    if (url === '/api/channels/message/reaction' && req.method === 'POST') return handleChannelMessageReaction(req, res);

    // Чаты
    if (url === '/api/chats' && req.method === 'GET') return handleChatsGet(req, res, query);
    if (url === '/api/chats' && req.method === 'POST') return handleChatCreate(req, res);
    if (url === '/api/chats/messages' && req.method === 'GET') return handleChatMessagesGet(req, res, query);
    if (url === '/api/chats/message' && req.method === 'POST') return handleChatMessageCreate(req, res);

    // Посты
    if (url === '/api/posts/feed' && req.method === 'GET') return handleFeedGet(req, res, query);
    if (url === '/api/posts' && req.method === 'GET') return handlePostsGet(req, res, query);
    if (url === '/api/posts' && req.method === 'POST') return handlePostsCreate(req, res);
    if (url === '/api/posts/like' && req.method === 'POST') return handlePostLike(req, res);
    if (url === '/api/posts/comment' && req.method === 'POST') return handlePostComment(req, res);
    if (url === '/api/posts/comments' && req.method === 'GET') return handleCommentsGet(req, res, query);
    if (url === '/api/posts/repost' && req.method === 'POST') return handlePostRepost(req, res);

    // ЛС
    if (url === '/api/dm' && req.method === 'GET') return handleDmGet(req, res, query);
    if (url === '/api/dm' && req.method === 'POST') return handleDmCreate(req, res);
    if (url === '/api/dm/conversations' && req.method === 'GET') return handleDmConversations(req, res, query);
    if (url === '/api/dm/unread-count' && req.method === 'GET') return handleDmUnreadCount(req, res, query);

    // Главная страница
    if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML_CONTENT);
        return;
    }

    sendJSON(res, 404, { error: 'Не найдено' });
});

server.listen(PORT, '0.0.0.0', function () {
    console.log('');
    console.log('🔥 Сервер Hot успешно запущен!');
    console.log('👉 Открой в браузере: http://localhost:' + PORT);
    console.log('');
});
