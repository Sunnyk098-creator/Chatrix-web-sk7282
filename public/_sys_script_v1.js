/*
 * Chatrix — Direct Realtime Engine (public/_sys_script_v1.js)
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { 
    getDatabase, ref, set, get, child, onValue, push, update, remove, 
    serverTimestamp, onDisconnect 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js";

// SECURE FIREBASE INITIALIZATION FROM VERCEL API
const firebaseConfig = window.__FB_CFG || {};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const APP_ID = 'chatrix-app';
const OFFICIAL_SYSTEM_UID = 'chatrix_official';
const RESERVED_USERNAMES = ['chatrix', 'chatrix_official', 'chatrixofficial', 'official'];

const dbUsersPath = `artifacts/${APP_ID}/users`;
const dbChatsPath = `artifacts/${APP_ID}/chats`;
const dbUserChatsPath = `artifacts/${APP_ID}/userChats`;
const dbStoriesPath = `artifacts/${APP_ID}/stories`;
const dbGroupsPath = `artifacts/${APP_ID}/groups`;
const dbStickerPacksPath = `artifacts/${APP_ID}/stickerPacks`;

// STATE & GLOBALS
window.currentUser = null;
window.activeChatId = null;
window.activeChatUserId = null;
window.activeChatUser = null;
window.activeChatIsGroup = false;

let activeChatsList = [];
let allUsersCache = {};
let currentFolderFilter = 'All';

let userFolders = JSON.parse(localStorage.getItem('chatrix_folders') || '{}');
let archivedChatIds = JSON.parse(localStorage.getItem('chatrix_archived') || '[]');

let currentReplyTarget = null;
let isSelectionMode = false;
let selectedChatIds = new Set();

let storyCanvas = null;
let storyCtx = null;
let storyImage = null;
let isBrushActive = false;
let isDrawing = false;

let messagesUnsub = null;
let liveStatusUnsub = null;
let typingStatusUnsub = null; 

window.targetChatMetaUnsub = null;
window.isTargetUnread = true;
let currentChatMessages = [];

let enterIsSend = localStorage.getItem('chatrix_enter_is_send') !== 'false';
window.currentViewingStory = null; 

let typingTimeout = null;

// STICKER STUDIO CANVAS STATE
let stickerCanvas = null;
let stickerCtx = null;
let isStickerPainting = false;
let stickerBrushActive = true;
let currentActivePackId = null;

// BAN COUNTDOWN TIMER
let banCountdownTimer = null;

// PROFILE DUAL COLOR STATE
let profileTempColor1 = '#3b82f6';
let profileTempColor2 = '';

// ==========================================
// DATABASE-BACKED RATE LIMITING & SECURITY GUARDS
// ==========================================

// 1. Rapid reload rate limit check (> 7 reloads in 12s -> 2 Hour Ban in Firebase Database)
(function enforceReloadRateLimit() {
    try {
        const now = Date.now();
        const RELOAD_KEY = 'chatrix_reload_history';

        let history = JSON.parse(localStorage.getItem(RELOAD_KEY) || '[]');
        history = history.filter(ts => now - ts < 12000);
        history.push(now);
        localStorage.setItem(RELOAD_KEY, JSON.stringify(history));

        if (history.length > 7) {
            localStorage.removeItem(RELOAD_KEY);
            const savedUser = JSON.parse(localStorage.getItem('chatrix_user') || 'null');
            if (savedUser && savedUser.uid) {
                const banExpiry = now + (2 * 60 * 60 * 1000); // 2 hours
                // PERSIST BAN IN FIREBASE DATABASE SO NO BROWSER CHANGE CAN BYPASS
                update(ref(db, `${dbUsersPath}/${savedUser.uid}`), {
                    isBanned: true,
                    banReason: "Suspicious activity detected: rapid app reload spam.",
                    banExpiresAt: banExpiry
                }).catch(() => {});
            }
        }
    } catch(e) {}
})();

// Check if user is currently banned directly from Realtime Database
function checkAndEnforceBan() {
    const now = Date.now();
    let isBanned = false;
    let reason = "Violation of terms or suspicious activity.";
    let expiresAt = null;
    let isPermanent = false;

    // Check Firebase Database Ban State
    if (window.currentUser && window.currentUser.isBanned) {
        if (window.currentUser.banExpiresAt) {
            if (window.currentUser.banExpiresAt > now) {
                isBanned = true;
                reason = window.currentUser.banReason || "Account temporarily restricted.";
                expiresAt = window.currentUser.banExpiresAt;
            } else {
                // Ban has expired! Automatically unban in Database
                update(ref(db, `${dbUsersPath}/${window.currentUser.uid}`), {
                    isBanned: false,
                    banReason: null,
                    banExpiresAt: null
                }).catch(() => {});
                window.currentUser.isBanned = false;
                window.currentUser.banReason = null;
                window.currentUser.banExpiresAt = null;
                localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));
                isBanned = false;
            }
        } else {
            // No expiration timestamp => Permanent admin ban
            isBanned = true;
            reason = window.currentUser.banReason || "Account suspended by Administrator.";
            isPermanent = true;
        }
    }

    const overlay = document.getElementById('banned-overlay');
    if (isBanned) {
        // ANTI-DEVTOOLS BYPASS: Lock body & wipe listeners + DOM data
        document.body.classList.add('is-user-banned');

        if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
        const msgContainer = document.getElementById('messages-container');
        if (msgContainer) msgContainer.innerHTML = '';
        const chatList = document.getElementById('chat-list');
        if (chatList) chatList.innerHTML = '';

        if (overlay) {
            overlay.classList.remove('hidden');
            overlay.style.display = 'flex';
        }

        if (document.getElementById('banned-dp')) document.getElementById('banned-dp').src = window.currentUser?.dp || 'https://placehold.co/150';
        if (document.getElementById('banned-name')) document.getElementById('banned-name').innerText = window.currentUser?.name || 'User';
        if (document.getElementById('banned-username')) document.getElementById('banned-username').innerText = window.currentUser?.username ? `@${window.currentUser.username}` : '@user';

        const reasonEl = document.getElementById('ban-reason-text');
        if (reasonEl) reasonEl.innerText = reason;

        const badgeEl = document.getElementById('ban-type-badge');
        const timerEl = document.getElementById('ban-countdown-timer');

        if (isPermanent) {
            if (badgeEl) {
                badgeEl.innerText = "Permanent Administrative Ban";
                badgeEl.className = "inline-block mt-1 text-[9px] font-bold px-2 py-0.5 rounded-full bg-red-600 text-white";
            }
            if (timerEl) timerEl.innerText = "PERMANENT";
            if (banCountdownTimer) clearInterval(banCountdownTimer);
        } else if (expiresAt) {
            if (badgeEl) {
                badgeEl.innerText = "Temporary Restriction";
                badgeEl.className = "inline-block mt-1 text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300";
            }

            function updateTimer() {
                const diff = expiresAt - Date.now();
                if (diff <= 0) {
                    if (timerEl) timerEl.innerText = "Expired. Please refresh.";
                    if (banCountdownTimer) clearInterval(banCountdownTimer);
                    // Clear ban in DB
                    if (window.currentUser) {
                        update(ref(db, `${dbUsersPath}/${window.currentUser.uid}`), {
                            isBanned: false,
                            banReason: null,
                            banExpiresAt: null
                        }).then(() => window.location.reload());
                    } else {
                        window.location.reload();
                    }
                    return;
                }
                const hrs = Math.floor(diff / 3600000);
                const mins = Math.floor((diff % 3600000) / 60000);
                const secs = Math.floor((diff % 60000) / 1000);
                if (timerEl) timerEl.innerText = `${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
            }

            if (banCountdownTimer) clearInterval(banCountdownTimer);
            updateTimer();
            banCountdownTimer = setInterval(updateTimer, 1000);
        }

        return true;
    } else {
        document.body.classList.remove('is-user-banned');
        if (overlay) {
            overlay.classList.add('hidden');
            overlay.style.display = 'none';
        }
        if (banCountdownTimer) {
            clearInterval(banCountdownTimer);
            banCountdownTimer = null;
        }
        return false;
    }
}

// 2. Check Premium Request Spam (> 3 requests in 1 min -> 5 Hour Ban in Database)
async function checkPremiumRequestRateLimit() {
    if (!window.currentUser?.uid) return false;
    const now = Date.now();
    const key = 'chatrix_premium_submits';
    let history = JSON.parse(localStorage.getItem(key) || '[]');
    history = history.filter(ts => now - ts < 60000);
    history.push(now);
    localStorage.setItem(key, JSON.stringify(history));

    if (history.length >= 3) {
        const banExpiry = now + (5 * 60 * 60 * 1000); // 5 hours
        // STORE DIRECTLY IN DATABASE
        await update(ref(db, `${dbUsersPath}/${window.currentUser.uid}`), {
            isBanned: true,
            banReason: "Excessive premium verification requests submitted.",
            banExpiresAt: banExpiry
        });
        window.currentUser.isBanned = true;
        window.currentUser.banReason = "Excessive premium verification requests submitted.";
        window.currentUser.banExpiresAt = banExpiry;
        localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));
        checkAndEnforceBan();
        return true;
    }
    return false;
}

// ==========================================
// E2E ENCRYPTION UTILS (Base64 + Prefix)
// ==========================================
function encryptData(text) {
    if(!text) return text;
    try { 
        return "CTX:" + btoa(encodeURIComponent(String(text))); 
    } catch(e) { 
        return String(text); 
    }
}

function decryptData(encodedText) {
    if(!encodedText) return encodedText;
    const str = String(encodedText);
    if (str.startsWith("CTX:")) {
        try { 
            return decodeURIComponent(atob(str.substring(4))); 
        } catch(e) { 
            return str; 
        }
    }
    try { 
        return decodeURIComponent(atob(str)); 
    } catch(e) { 
        return str; 
    }
}

const GRADIENT_MAP = {
    "from-blue-500 to-blue-600": "linear-gradient(to bottom, #3b82f6, #2563eb)",
    "from-green-500 to-green-600": "linear-gradient(to bottom, #22c55e, #16a34a)",
    "from-yellow-300 to-yellow-400": "linear-gradient(to bottom, #fde047, #facc15)",
    "from-orange-500 to-orange-600": "linear-gradient(to bottom, #f97316, #ea580c)",
    "from-red-500 to-red-600": "linear-gradient(to bottom, #ef4444, #dc2626)",
    "from-pink-500 to-pink-600": "linear-gradient(to bottom, #ec4899, #db2777)",
    "from-purple-500 to-purple-600": "linear-gradient(to bottom, #a855f7, #9333ea)",
    "from-blue-500 to-purple-600": "linear-gradient(to bottom right, #3b82f6, #9333ea)",
    "from-emerald-400 to-cyan-500": "linear-gradient(to bottom right, #34d399, #06b6d4)",
    "from-rose-400 to-red-500": "linear-gradient(to bottom right, #fb7185, #ef4444)",
    "from-amber-400 to-orange-500": "linear-gradient(to bottom right, #fbbf24, #f97316)",
    "from-purple-500 to-pink-500": "linear-gradient(to bottom right, #a855f7, #ec4899)",
    "from-indigo-500 to-cyan-400": "linear-gradient(to bottom right, #6366f1, #22d3ee)",
    "": ""
};

// STRICT NO-SPACE SANITIZER
function normalizeUsername(raw) {
    if (!raw) return '';
    return String(raw).replace(/^@+/, '').replace(/\s+/g, '').toLowerCase().trim();
}

function formatLastSeenTime(timestamp) {
    if (!timestamp) return 'recently';
    const d = new Date(timestamp);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return isToday ? `at ${timeStr}` : `on ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeStr}`;
}

// -------------------------------------------------------------
// PROFILE / CONTACT TAB FIXES
// -------------------------------------------------------------

window.switchContactTab = function(tab) {
    const posts = document.getElementById('overlay-profile-posts-grid');
    const media = document.getElementById('overlay-profile-media-grid');
    const links = document.getElementById('overlay-profile-links-list');
    const btnPosts = document.getElementById('tab-btn-posts');
    const btnMedia = document.getElementById('tab-btn-media');
    const btnLinks = document.getElementById('tab-btn-links');
    
    if(!posts || !media || !links) return;

    posts.classList.add('hidden');
    media.classList.add('hidden');
    links.classList.add('hidden');
    
    [btnPosts, btnMedia, btnLinks].forEach(b => {
        if(b) b.className = 'flex-1 py-3.5 text-xs font-bold text-gray-500 dark:text-gray-400 transition-all';
    });

    if(tab === 'posts') {
        posts.classList.remove('hidden');
        if(btnPosts) btnPosts.className = 'flex-1 py-3.5 text-xs font-bold text-blue-600 border-b-2 border-blue-600 transition-all';
    } else if(tab === 'media') {
        media.classList.remove('hidden');
        media.style.display = 'grid'; 
        if(btnMedia) btnMedia.className = 'flex-1 py-3.5 text-xs font-bold text-blue-600 border-b-2 border-blue-600 transition-all';
    } else if(tab === 'links') {
        links.classList.remove('hidden');
        links.style.display = 'flex';
        if(btnLinks) btnLinks.className = 'flex-1 py-3.5 text-xs font-bold text-blue-600 border-b-2 border-blue-600 transition-all';
    }
};

window.closeUserProfile = function() {
    const overlay = document.getElementById('user-profile-overlay');
    if(overlay) {
        overlay.classList.add('hidden');
        overlay.style.display = 'none';
    }
};

window.openUserProfileDirect = async function(uid) {
    if (!uid && window.activeChatUser) {
        uid = window.activeChatUserId || window.activeChatUser.targetUid;
    }
    if (!uid) return;

    let u = allUsersCache[uid];
    if (!u) {
        const snap = await get(child(ref(db), `${dbUsersPath}/${uid}`));
        if (snap.exists()) u = snap.val();
    }
    if (!u) return window.showToast("User not found", "exclamation-circle", "text-red-400");

    document.getElementById('overlay-profile-dp').src = u.dp || 'https://placehold.co/150';
    
    // TICK REMOVAL FIX: Tick only shows if user is premium or official service account
    const isOfficialUser = uid === OFFICIAL_SYSTEM_UID;
    const hasTick = Boolean(isOfficialUser || u.isPremium === true);
    let tColor = u.verifiedTickColor || 'text-blue-500';
    let verifiedIcon = hasTick ? `<i class="fas fa-check-circle ${tColor} text-xs ml-1"></i>` : '';
    document.getElementById('overlay-profile-name').innerHTML = `${u.name} ${verifiedIcon}`;
    
    document.getElementById('overlay-profile-username').textContent = `@${u.username}`;
    document.getElementById('overlay-profile-bio').textContent = u.bio || 'No bio available';
    document.getElementById('overlay-profile-birthday').textContent = u.birthday || 'Not Provided';

    const statusEl = document.getElementById('overlay-profile-status-text');
    if (u.status && u.status.online) {
        statusEl.innerHTML = `<span class="text-emerald-500 font-bold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> online</span>`;
    } else if (u.status && u.status.lastSeen) {
        statusEl.innerHTML = `<span class="text-gray-400 font-medium">Last seen ${formatLastSeenTime(u.status.lastSeen)}</span>`;
    } else {
        statusEl.innerHTML = `<span class="text-gray-400 font-medium">offline</span>`;
    }

    applyProfileCoverStyle(u, 'overlay-profile');
    renderTargetProfilePosts(uid);
    populateContactMediaAndLinks();
    window.switchContactTab('posts');

    document.getElementById('user-profile-overlay').classList.remove('hidden');
    document.getElementById('user-profile-overlay').style.display = 'flex';
};

window.openChatHeaderTarget = function() {
    if (window.activeChatIsGroup) {
        window.openGroupDetailsModal(window.activeChatId);
    } else {
        window.openUserProfileDirect();
    }
};

// -------------------------------------------------------------
// STORIES RENDERING
// -------------------------------------------------------------
window.renderStoriesFeed = async function() {
    const container = document.getElementById('stories-feed-container');
    if (!container) return;

    try {
        const snap = await get(ref(db, dbStoriesPath));
        if (!snap.exists()) {
            container.innerHTML = `<div class="py-20 text-center text-gray-400 text-xs font-semibold">No active stories available.</div>`;
            return;
        }

        const all = snap.val();
        const now = Date.now();
        const active = [];

        for (let id of Object.keys(all)) {
            const s = all[id];
            if (now - (s.createdAt || 0) <= 24 * 60 * 60 * 1000) {
                const isOwner = s.ownerUid === window.currentUser?.uid;
                const isAudience = !s.audience || s.audience.includes(window.currentUser?.uid);
                if (isOwner || isAudience) active.push({ id, ...s });
            }
        }

        if (active.length === 0) {
            container.innerHTML = `<div class="py-20 text-center text-gray-400 text-xs font-semibold">No active stories right now.</div>`;
            return;
        }

        container.innerHTML = '';
        active.forEach(s => {
            const isOwner = s.ownerUid === window.currentUser?.uid;
            const ownerObj = allUsersCache[s.ownerUid] || { name: s.ownerName || 'User', dp: s.ownerDp || 'https://placehold.co/100' };
            const card = document.createElement('div');
            card.className = 'bg-white dark:bg-[#1e293b] rounded-3xl overflow-hidden shadow-sm border border-gray-100 dark:border-white/5 flex flex-col';
            
            const storyData = encodeURIComponent(JSON.stringify({
                id: s.id, ownerUid: s.ownerUid, ownerName: ownerObj.name, 
                ownerDp: ownerObj.dp, photo: s.photo, storyText: s.storyText || '', createdAt: s.createdAt
            }));

            const likesCount = Object.keys(s.likes || {}).length;
            const viewsCount = Object.keys(s.views || {}).length;
            const isLiked = s.likes && s.likes[window.currentUser?.uid];

            card.innerHTML = `
                <div class="p-3 flex items-center justify-between border-b border-gray-50 dark:border-white/5">
                    <div class="flex items-center gap-2 cursor-pointer" onclick="window.openUserProfileDirect('${s.ownerUid}')">
                        <img src="${ownerObj.dp}" class="w-8 h-8 rounded-full object-cover">
                        <div>
                            <h4 class="font-bold text-xs text-gray-900 dark:text-white">${ownerObj.name}</h4>
                            <span class="text-[9px] text-gray-400">${new Date(s.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                        </div>
                    </div>
                    ${isOwner ? `<button onclick="window.deleteStory('${s.id}')" class="text-gray-400 hover:text-red-500 text-xs p-1"><i class="fas fa-trash"></i></button>` : ''}
                </div>
                <div class="bg-black flex items-center justify-center max-h-80 overflow-hidden cursor-pointer relative" onclick="window.viewStoryFullscreen('${storyData}')">
                    <img src="${s.photo}" class="w-full object-contain max-h-80">
                    ${s.storyText ? `<div class="absolute bg-black/60 text-white px-3 py-1 rounded-lg text-xs font-bold whitespace-nowrap border border-white/20">${s.storyText}</div>` : ''}
                </div>
                <div class="p-3.5 space-y-2 relative">
                    ${s.caption ? `<p class="text-xs font-medium text-gray-800 dark:text-gray-200">${s.caption}</p>` : ''}
                    <div class="flex items-center justify-between pt-1.5 border-t border-gray-50 dark:border-white/5 text-xs text-gray-500 dark:text-gray-400">
                        <button onclick="window.toggleStoryLike('${s.id}')" class="font-bold flex items-center gap-1 ${isLiked ? 'text-red-500' : ''} transition-colors">
                            <i class="fas fa-heart"></i> ${likesCount}
                        </button>
                        ${isOwner ? `<span class="text-[10px] font-bold text-blue-500"><i class="fas fa-eye"></i> ${viewsCount} views</span>` : ''}
                    </div>
                </div>
            `;
            container.appendChild(card);
        });
    } catch (e) {
        console.error(e);
    }
};

window.toggleStoryLike = async (storyId) => {
    if (!window.currentUser) return;
    const uid = window.currentUser.uid;
    const likeRef = ref(db, `${dbStoriesPath}/${storyId}/likes/${uid}`);
    const snap = await get(likeRef);
    if (snap.exists()) {
        await remove(likeRef);
    } else {
        await set(likeRef, true);
    }
};

window.viewStoryFullscreen = async (storyStr) => {
    const s = JSON.parse(decodeURIComponent(storyStr));
    window.currentViewingStory = s;
    
    document.getElementById('story-viewer-img').src = s.photo;
    document.getElementById('story-viewer-dp').src = s.ownerDp;
    document.getElementById('story-viewer-name').innerHTML = s.ownerName;
    document.getElementById('story-viewer-time').innerText = new Date(s.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    const textEl = document.getElementById('story-viewer-text');
    if(s.storyText) {
        textEl.innerText = s.storyText;
        textEl.classList.remove('hidden');
    } else {
        textEl.classList.add('hidden');
    }
    
    document.getElementById('story-reply-input').value = '';
    
    const replyBar = document.getElementById('story-reply-input').parentElement;
    if (s.ownerUid === window.currentUser?.uid) {
        replyBar.classList.add('hidden');
    } else {
        replyBar.classList.remove('hidden');
        await set(ref(db, `${dbStoriesPath}/${s.id}/views/${window.currentUser.uid}`), true);
    }

    const overlay = document.getElementById('story-viewer-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.style.display = 'flex';
    }
};

window.closeStoryViewer = () => {
    const overlay = document.getElementById('story-viewer-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
        overlay.style.display = 'none';
    }
};

window.sendStoryReply = async () => {
    const replyInput = document.getElementById('story-reply-input');
    const text = replyInput.value.trim();
    if (!text || !window.currentViewingStory) return;

    const s = window.currentViewingStory;
    window.closeStoryViewer();
    window.switchTab('home'); 
    
    const cleanUser = s.ownerUid;
    openDirectChatWithUser({
        uid: cleanUser,
        name: s.ownerName,
        username: cleanUser,
        dp: s.ownerDp,
        isPremium: false 
    });

    setTimeout(() => {
        dispatchMessage(`Replying to your story:\n\n${text}`, s.photo);
    }, 600);
};

window.openStoryViewerProfile = () => {
    if(window.currentViewingStory) {
        window.closeStoryViewer();
        window.openUserProfileDirect(window.currentViewingStory.ownerUid);
    }
};

window.renderMyProfilePosts = async function() {
    const grid = document.getElementById('my-profile-posts-grid');
    if (!grid) return;
    if (!window.currentUser?.uid) return;

    try {
        const snap = await get(ref(db, dbStoriesPath));
        if (!snap.exists()) {
            grid.innerHTML = `<div class="col-span-2 text-center py-6 text-gray-400 text-xs">No posts history yet.</div>`;
            return;
        }

        const all = snap.val();
        const my = Object.keys(all).map(k => ({ id: k, ...all[k] })).filter(s => s.ownerUid === window.currentUser.uid);

        if (my.length === 0) {
            grid.innerHTML = `<div class="col-span-2 text-center py-6 text-gray-400 text-xs">No posts history yet.</div>`;
            return;
        }

        grid.innerHTML = '';
        my.forEach(p => {
            grid.innerHTML += `
                <div class="relative group rounded-2xl overflow-hidden shadow-sm border border-gray-100 dark:border-white/5 bg-black aspect-square cursor-pointer" onclick="window.previewImage('${p.photo}')">
                    <img src="${p.photo}" class="w-full h-full object-cover">
                    <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-3 text-white text-xs font-bold transition-opacity">
                        <span><i class="fas fa-heart text-red-500"></i> ${Object.keys(p.likes || {}).length}</span>
                        <button onclick="event.stopPropagation(); window.deleteStory('${p.id}')" class="text-red-400 hover:text-red-600"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `;
        });
    } catch (e) {
        grid.innerHTML = `<div class="col-span-2 text-center py-6 text-gray-400 text-xs">No posts history yet.</div>`;
    }
};

async function renderTargetProfilePosts(targetUid) {
    const grid = document.getElementById('overlay-profile-posts-grid');
    if (!grid) return;

    try {
        const snap = await get(ref(db, dbStoriesPath));
        if (!snap.exists()) {
            grid.innerHTML = `<div class="col-span-3 text-center py-6 text-gray-400 text-xs">No available posts.</div>`;
            return;
        }

        const all = snap.val();
        const posts = Object.keys(all).map(k => ({ id: k, ...all[k] })).filter(s => {
            const isAuthor = s.ownerUid === targetUid;
            const isAudience = !s.audience || s.audience.includes(window.currentUser?.uid);
            return isAuthor && isAudience;
        });

        if (posts.length === 0) {
            grid.innerHTML = `<div class="col-span-3 text-center py-6 text-gray-400 text-xs">No available posts.</div>`;
            return;
        }

        grid.innerHTML = '';
        posts.forEach(p => {
            grid.innerHTML += `
                <div class="rounded-lg overflow-hidden shadow-sm border border-gray-100 dark:border-white/5 bg-black aspect-square cursor-pointer" onclick="window.previewImage('${p.photo}')">
                    <img src="${p.photo}" class="w-full h-full object-cover">
                </div>
            `;
        });
    } catch (e) {
        grid.innerHTML = `<div class="col-span-3 text-center py-6 text-gray-400 text-xs">No available posts.</div>`;
    }
}

// -------------------------------------------------------------
// APP INITIALIZATION, URL ROUTING & SESSION
// -------------------------------------------------------------
function hideSplash() {
    const splash = document.getElementById('splash-screen');
    if (splash) {
        splash.style.transition = 'opacity 0.3s ease';
        splash.style.opacity = '0';
        splash.style.pointerEvents = 'none';
        setTimeout(() => {
            splash.style.display = 'none';
            splash.classList.add('hidden');
        }, 300);
    }
}

async function autoLoginFromUrl(rawUser, pass) {
    const user = normalizeUsername(rawUser).replace(/[.#$\[\]]/g, '_');
    try {
        const snap = await get(child(ref(db), `${dbUsersPath}/${user}`));
        if (!snap.exists() || decryptData(snap.val().password) !== pass) throw new Error("Invalid URL credentials");
        
        window.currentUser = snap.val();
        localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));
        
        window.history.replaceState({}, document.title, window.location.pathname);
        proceedToMainApp();
    } catch (err) {
        window.showToast("URL Login Failed: " + err.message, "exclamation-circle", "text-red-400");
        window.history.replaceState({}, document.title, window.location.pathname);
        switchMainView('login-view');
        hideSplash();
    }
}

async function checkSession() {
    const saved = localStorage.getItem('chatrix_user');
    if (!saved) {
        switchMainView('login-view');
        hideSplash();
        return;
    }

    try {
        const u = JSON.parse(saved);
        if (!u || !u.uid) throw new Error();

        const snap = await get(ref(db, `${dbUsersPath}/${u.uid}`));
        if (snap && snap.exists()) {
            window.currentUser = snap.val();
            localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));
            proceedToMainApp();
        } else {
            localStorage.removeItem('chatrix_user');
            switchMainView('login-view');
        }
    } catch (err) {
        switchMainView('login-view');
    } finally {
        hideSplash();
    }
}

function initApp() {
    try {
        applyStoredAppearance();
        setupDomListeners();
        
        const urlParams = new URLSearchParams(window.location.search);
        const urlUser = urlParams.get('username') || urlParams.get('Username');
        const urlPass = urlParams.get('pass');

        if (urlUser && urlPass) {
            autoLoginFromUrl(urlUser, urlPass);
        } else {
            checkSession();
        }
    } catch (err) {
        hideSplash();
        switchMainView('login-view');
    }
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

setTimeout(() => { hideSplash(); }, 2500);

function proceedToMainApp() {
    populateUserData();
    switchMainView('main-app');
    
    listenToMaintenance();
    listenToUsersLive();
    listenToActiveChatsLive();
    listenToStoriesLive();
    listenToPresence();
    registerDeviceSession();
    hideSplash();
    
    // Check bans after user data is ready from Firebase
    checkAndEnforceBan();

    const urlParams = new URLSearchParams(window.location.search);
    const urlUser = urlParams.get('username') || urlParams.get('Username');
    const urlPass = urlParams.get('pass');
    
    if (urlUser && !urlPass) {
        setTimeout(() => {
            window.history.replaceState({}, document.title, window.location.pathname);
            window.handleMentionClick(urlUser);
        }, 1200);
    }
}

function listenToStoriesLive() {
    try {
        onValue(ref(db, dbStoriesPath), () => {
            if (document.getElementById('stories-tab')?.classList.contains('tab-visible')) {
                window.renderStoriesFeed();
            }
            if (document.getElementById('profile-tab')?.classList.contains('tab-visible')) {
                window.renderMyProfilePosts();
            }
            if (document.getElementById('user-profile-overlay')?.style.display === 'flex' && window.activeChatUser?.targetUid) {
                renderTargetProfilePosts(window.activeChatUser.targetUid);
            }
        });
    } catch(e) {}
}

function switchMainView(viewId) {
    ['login-view', 'signup-view', 'main-app'].forEach(v => {
        const el = document.getElementById(v);
        if (el) {
            el.classList.toggle('view-visible', v === viewId);
            el.classList.toggle('view-hidden', v !== viewId);
        }
    });
    if (viewId === 'main-app') window.switchTab('home');
}

// -------------------------------------------------------------
// REALTIME PRESENCE & ADMIN MAINTENANCE/BAN
// -------------------------------------------------------------

function listenToMaintenance() {
    onValue(ref(db, `artifacts/${APP_ID}/settings/maintenance`), (snap) => {
        const overlay = document.getElementById('maintenance-overlay');
        if(!overlay) return;
        if(snap.exists() && snap.val() === true) {
            overlay.classList.remove('hidden');
            overlay.style.display = 'flex';
        } else {
            overlay.classList.add('hidden');
            overlay.style.display = 'none';
        }
    });
}

function listenToPresence() {
    const connectedRef = ref(db, ".info/connected");
    onValue(connectedRef, (snap) => {
        if (snap.val() === true && window.currentUser) {
            const statusRef = ref(db, `${dbUsersPath}/${window.currentUser.uid}/status`);
            onDisconnect(statusRef).set({ online: false, lastSeen: serverTimestamp(), typingTo: null });
            set(statusRef, { online: true, typingTo: null });
        }
    });
}

function listenToUsersLive() {
    onValue(ref(db, dbUsersPath), (snap) => {
        if (snap.exists()) {
            allUsersCache = snap.val();
            if (window.currentUser && allUsersCache[window.currentUser.uid]) {
                window.currentUser = allUsersCache[window.currentUser.uid];
                
                // Realtime Database-Level Ban enforcement
                const isBanned = checkAndEnforceBan();
                if (isBanned) return;

                populateUserData();
            }
        }
    });
}

window.submitBanAppeal = async (text) => {
    if(!window.currentUser) return;
    const btn = document.getElementById('submit-appeal-btn');
    if(!btn) return;
    
    const originalText = btn.innerText;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';
    
    try {
        await set(ref(db, `artifacts/${APP_ID}/appeals/${window.currentUser.uid}`), {
            text: text,
            timestamp: Date.now()
        });
        window.showToast("Appeal submitted successfully!", "check-circle", "text-green-400");
        document.getElementById('appeal-modal').classList.add('hidden');
        if(document.getElementById('appeal-text')) document.getElementById('appeal-text').value = '';
    } catch(e) {
        window.showToast("Error submitting appeal.", "exclamation-circle", "text-red-400");
    } finally {
        btn.innerText = originalText;
    }
};

// -------------------------------------------------------------
// REALTIME CHATS
// -------------------------------------------------------------
function listenToActiveChatsLive() {
    if (!window.currentUser?.uid) return;
    const myChatsRef = ref(db, `${dbUserChatsPath}/${window.currentUser.uid}`);
    onValue(myChatsRef, async (snapshot) => {
        const data = snapshot.val();
        if (!data) {
            activeChatsList = [];
            renderChatList();
            return;
        }

        const list = [];
        for (let cId of Object.keys(data)) {
            const chatMeta = data[cId];
            
            let otherUid = chatMeta.targetUid;
            if (!otherUid && !chatMeta.isGroup) {
                if (cId.startsWith(window.currentUser.uid + '_')) {
                    otherUid = cId.substring(window.currentUser.uid.length + 1);
                } else if (cId.endsWith('_' + window.currentUser.uid)) {
                    otherUid = cId.substring(0, cId.length - window.currentUser.uid.length - 1);
                } else {
                    const parts = cId.split('_');
                    otherUid = parts[0] === window.currentUser.uid ? parts[1] : parts[0];
                }
            }

            const isSelf = otherUid === window.currentUser.uid;
            let name = chatMeta.name;
            let dp = chatMeta.dp;
            let username = chatMeta.username || otherUid;
            let tickColor = 'text-blue-500';
            let isOfficial = otherUid === OFFICIAL_SYSTEM_UID;
            let isVerified = false;

            if (isSelf) {
                name = 'Saved Messages';
                dp = 'https://placehold.co/150/2563eb/ffffff?text=Saved';
                isVerified = false;
            } else if (isOfficial) {
                name = 'Chatrix';
                username = 'chatrix_official';
                dp = 'https://placehold.co/150/2563eb/ffffff?text=CX';
                isVerified = true;
            } else if (chatMeta.isGroup) {
                name = chatMeta.name || 'Group';
                dp = chatMeta.dp || 'https://placehold.co/150/2563eb/ffffff?text=GRP';
                isVerified = false;
            } else if (otherUid && allUsersCache[otherUid]) {
                const u = allUsersCache[otherUid];
                name = typeof u.name === 'string' ? u.name : (u.username || otherUid);
                username = typeof u.username === 'string' ? u.username : otherUid;
                dp = u.dp || `https://placehold.co/150/2563eb/ffffff?text=${name.charAt(0).toUpperCase()}`;
                // TICK REMOVAL FIX: Verified tick only exists if user has isPremium === true
                isVerified = Boolean(u.isPremium === true);
                tickColor = u.verifiedTickColor || 'text-blue-500';
            } else {
                isVerified = Boolean(chatMeta.isPremium === true);
            }
            
            let displayLastMsg = decryptData(chatMeta.lastMessage) || 'Conversation started';

            list.push({
                id: cId, targetUid: otherUid || null, name: name || 'User', username: username || 'user',
                dp: dp || 'https://placehold.co/150/2563eb/ffffff?text=U', isVerified: Boolean(isVerified), tickColor,
                isOfficial: isOfficial, isSelf: isSelf, isGroup: Boolean(chatMeta.isGroup),
                lastMessage: displayLastMsg, timestamp: chatMeta.timestamp || 0,
                time: chatMeta.timestamp ? new Date(chatMeta.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
                unread: Boolean(chatMeta.unread), pinned: Boolean(chatMeta.pinned)
            });
        }

        list.sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return (b.timestamp || 0) - (a.timestamp || 0);
        });

        activeChatsList = list;
        renderChatList();
    });
}

function renderChatList() {
    const container = document.getElementById('chat-list');
    if (!container) return;

    const visibleChats = activeChatsList.filter(c => !archivedChatIds.includes(c.id));

    if (visibleChats.length === 0) {
        container.innerHTML = `<div class="py-20 text-center text-gray-400 text-xs font-semibold">No active conversations. Search to start chatting!</div>`;
        return;
    }

    container.innerHTML = '';
    visibleChats.forEach(chat => {
        const isSelected = selectedChatIds.has(chat.id);
        const div = document.createElement('div');
        div.className = `flex items-center px-5 py-3.5 cursor-pointer border-b border-gray-100 dark:border-white/5 transition-colors ${chat.pinned ? 'pinned-bg' : 'hover:bg-gray-50 dark:hover:bg-slate-800'}`;

        let vHtml = chat.isVerified ? `<i class="fas fa-check-circle ${chat.tickColor} text-[10px]"></i>` : '';

        div.innerHTML = `
            ${isSelectionMode ? `<input type="checkbox" class="w-4 h-4 rounded mr-3 text-blue-600 pointer-events-none" ${isSelected ? 'checked' : ''}>` : ''}
            <div class="relative shrink-0 mr-3.5">
                <img src="${chat.dp}" class="w-12 h-12 rounded-full object-cover bg-white shadow-sm border border-gray-50 dark:border-white/10">
                ${chat.pinned ? '<div class="absolute -bottom-1 -right-1 bg-blue-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[9px] border border-white dark:border-[#0f172a]"><i class="fas fa-thumbtack"></i></div>' : ''}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex justify-between items-center mb-0.5">
                    <h4 class="font-bold text-xs truncate flex items-center gap-1 text-gray-900 dark:text-white">${chat.name} ${vHtml}</h4>
                    <span class="text-[10px] text-gray-400">${chat.time || ''}</span>
                </div>
                <div class="flex justify-between items-center">
                    <p class="text-xs ${chat.unread ? 'font-bold text-gray-900 dark:text-gray-100' : 'text-gray-500'} truncate">${chat.lastMessage}</p>
                    ${chat.unread ? '<div class="unread-dot ml-2"></div>' : ''}
                </div>
            </div>
        `;

        let timer;
        div.onmousedown = () => { timer = setTimeout(() => enterSelectionMode(chat.id), 500); };
        div.onmouseup = () => clearTimeout(timer);
        div.ontouchstart = () => { timer = setTimeout(() => enterSelectionMode(chat.id), 500); };
        div.ontouchend = () => clearTimeout(timer);

        div.onclick = () => {
            if (isSelectionMode) toggleChatSelection(chat.id);
            else openChat(chat);
        };

        container.appendChild(div);
    });
}

function openChat(chat) {
    window.activeChatId = chat.id;
    window.activeChatUserId = chat.targetUid || null;
    window.activeChatUser = chat;
    window.activeChatIsGroup = chat.isGroup === true;

    if (window.currentUser) {
        update(ref(db, `${dbUserChatsPath}/${window.currentUser.uid}/${chat.id}`), { unread: false }).catch(() => {});
    }

    const isSelf = chat.targetUid === window.currentUser?.uid;
    const displayName = isSelf ? 'Saved Messages' : chat.name;

    const nameEl = document.getElementById('active-chat-name');
    let vHtml = chat.isVerified ? `<i class="fas fa-check-circle ${chat.tickColor || 'text-blue-500'} text-xs ml-1"></i>` : '';
    if (nameEl) nameEl.innerHTML = `${displayName} ${vHtml}`;
    
    const dpEl = document.getElementById('active-chat-dp');
    if (dpEl) dpEl.src = chat.dp;
    const statusEl = document.getElementById('active-chat-status');

    if (liveStatusUnsub) { liveStatusUnsub(); liveStatusUnsub = null; }
    if (window.targetChatMetaUnsub) { window.targetChatMetaUnsub(); window.targetChatMetaUnsub = null; }
    window.isTargetUnread = true; 
    
    if (isSelf) {
        if (statusEl) statusEl.textContent = 'Messages saved to your account';
    } else if (chat.isOfficial) {
        if (statusEl) statusEl.textContent = 'Official Service Account';
    } else if (chat.isGroup) {
        if (statusEl) statusEl.textContent = 'Tap for group info';
    } else if (chat.targetUid) {
        liveStatusUnsub = onValue(ref(db, `${dbUsersPath}/${chat.targetUid}/status`), (snap) => {
            if (!statusEl || window.activeChatUserId !== chat.targetUid) return;
            const s = snap.val();
            
            if(s && s.typingTo === window.currentUser.uid) {
                 statusEl.innerHTML = `<span class="text-blue-500 font-bold italic animate-pulse">typing...</span>`;
            } else if (s && s.online) {
                statusEl.innerHTML = `<span class="text-emerald-500 font-bold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> online</span>`;
            } else if (s && s.lastSeen) {
                statusEl.innerHTML = `<span class="text-gray-400 font-medium">Last seen ${formatLastSeenTime(s.lastSeen)}</span>`;
            } else {
                statusEl.innerHTML = `<span class="text-gray-400 font-medium">offline</span>`;
            }
        });
        
        window.targetChatMetaUnsub = onValue(ref(db, `${dbUserChatsPath}/${chat.targetUid}/${chat.id}/unread`), (snap) => {
            if(window.activeChatUserId !== chat.targetUid) return;
            window.isTargetUnread = snap.exists() ? snap.val() : true;
            renderMessagesUI();
        });
    }

    updateChatMenuOptions();
    document.getElementById('chat-screen')?.classList.remove('hidden');

    const savedWall = localStorage.getItem(`chatrix_wallpaper_${chat.id}`);
    const container = document.getElementById('messages-container');
    if (container) container.style.backgroundImage = savedWall ? `url(${savedWall})` : '';

    loadLiveMessages(chat.id);
}

// TYPING STATUS EVENT HANDLER
const msgInputEl = document.getElementById('message-input');
if(msgInputEl) {
    msgInputEl.addEventListener('input', () => {
        if(!window.currentUser || !window.activeChatUserId || window.activeChatIsGroup) return;
        
        set(ref(db, `${dbUsersPath}/${window.currentUser.uid}/status/typingTo`), window.activeChatUserId);
        
        if(typingTimeout) clearTimeout(typingTimeout);
        
        typingTimeout = setTimeout(() => {
            set(ref(db, `${dbUsersPath}/${window.currentUser.uid}/status/typingTo`), null);
        }, 2500);
    });
}

document.getElementById('back-from-chat').onclick = () => {
    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }
    if (liveStatusUnsub) { liveStatusUnsub(); liveStatusUnsub = null; }
    if (window.targetChatMetaUnsub) { window.targetChatMetaUnsub(); window.targetChatMetaUnsub = null; }
    
    if(window.currentUser) {
        set(ref(db, `${dbUsersPath}/${window.currentUser.uid}/status/typingTo`), null).catch(()=>{});
    }
    
    window.activeChatId = null;
    window.activeChatUserId = null;
    window.activeChatUser = null;
    window.cancelReply();
    window.closeStickerDrawer();
    document.getElementById('chat-screen')?.classList.add('hidden');
};

async function updateChatMenuOptions() {
    const menu = document.getElementById('chat-menu-dropdown');
    if (!menu) return;

    if (!window.activeChatIsGroup) {
        menu.innerHTML = `
            <label class="block px-4 py-2 text-xs font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700/50 cursor-pointer">
                <i class="fas fa-image w-4 text-purple-500 mr-2"></i> Set Wallpaper
                <input type="file" id="chat-wallpaper-upload" accept="image/*" class="hidden">
            </label>
            <button class="w-full text-left px-4 py-2 text-xs font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700/50" onclick="window.openChatLinkHistory()">
                <i class="fas fa-link w-4 text-blue-500 mr-2"></i> Shared Links
            </button>
            <button class="w-full text-left px-4 py-2 text-xs font-semibold text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-900/20" onclick="window.clearChatHistoryAction()">
                <i class="fas fa-eraser w-4 mr-2"></i> Clear History
            </button>
            <button class="w-full text-left px-4 py-2 text-xs font-semibold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" onclick="window.deleteActiveChatAction()">
                <i class="fas fa-trash-alt w-4 mr-2"></i> Delete Chat
            </button>
        `;
    } else {
        const snap = await get(child(ref(db), `${dbGroupsPath}/${window.activeChatId}`));
        const grp = snap.exists() ? snap.val() : {};
        const isOwner = grp.ownerUid === window.currentUser?.uid;
        const isAdmin = Boolean(grp.admins && grp.admins[window.currentUser?.uid]);

        menu.innerHTML = `
            <label class="block px-4 py-2 text-xs font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-slate-700/50 cursor-pointer">
                <i class="fas fa-image w-4 text-purple-500 mr-2"></i> Change Wallpaper
                <input type="file" id="chat-wallpaper-upload" accept="image/*" class="hidden">
            </label>
            <button class="w-full text-left px-4 py-2 text-xs font-semibold text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-900/20" onclick="window.clearChatHistoryAction()">
                <i class="fas fa-eraser w-4 mr-2"></i> Clear History
            </button>
            <button class="w-full text-left px-4 py-2 text-xs font-semibold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" onclick="window.leaveGroup('${window.activeChatId}')">
                <i class="fas fa-sign-out-alt w-4 mr-2"></i> Leave Group
            </button>
            ${(isOwner || isAdmin) ? `
                <button class="w-full text-left px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onclick="window.deleteGroupAction('${window.activeChatId}')">
                    <i class="fas fa-trash-alt w-4 mr-2"></i> Delete Group
                </button>
            ` : ''}
        `;
    }

    const wallInput = document.getElementById('chat-wallpaper-upload');
    if (wallInput) {
        wallInput.onchange = async (e) => {
            if (e.target.files?.[0]) {
                const b64 = await fileToBase64(e.target.files[0], 600);
                localStorage.setItem(`chatrix_wallpaper_${window.activeChatId}`, b64);
                document.getElementById('messages-container').style.backgroundImage = `url(${b64})`;
                document.getElementById('chat-menu-dropdown')?.classList.add('hidden');
                window.showToast("Wallpaper set!");
            }
        };
    }
}

window.clearChatHistoryAction = () => {
    window.appConfirm("Clear all messages in this conversation?", async () => {
        await remove(ref(db, `${dbChatsPath}/${window.activeChatId}/messages`));
        await update(ref(db, `${dbUserChatsPath}/${window.currentUser.uid}/${window.activeChatId}`), { lastMessage: encryptData('History cleared') });
        window.showToast("History cleared");
        document.getElementById('chat-menu-dropdown')?.classList.add('hidden');
    });
};

window.deleteActiveChatAction = () => {
    window.appConfirm("Delete this conversation?", async () => {
        await remove(ref(db, `${dbUserChatsPath}/${window.currentUser.uid}/${window.activeChatId}`));
        window.showToast("Chat deleted");
        document.getElementById('back-from-chat')?.click();
    });
};

function loadLiveMessages(chatId) {
    const container = document.getElementById('messages-container');
    if (!container) return;
    container.innerHTML = '<div class="p-6 text-center text-gray-400 text-xs"><i class="fas fa-spinner fa-spin mr-1"></i> Loading...</div>';

    if (messagesUnsub) { messagesUnsub(); messagesUnsub = null; }

    messagesUnsub = onValue(ref(db, `${dbChatsPath}/${chatId}/messages`), (snapshot) => {
        if(window.activeChatId !== chatId) return;

        const data = snapshot.val();
        if (!data) {
            currentChatMessages = [];
            renderMessagesUI();
            return;
        }

        const msgs = Object.keys(data).map(k => ({ id: k, ...data[k] }));
        msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        currentChatMessages = msgs;
        renderMessagesUI();
    });
}

function renderMessagesUI() {
    const container = document.getElementById('messages-container');
    if (!container) return;
    
    if (currentChatMessages.length === 0) {
        container.innerHTML = '<div class="py-16 text-center text-gray-400 text-xs font-semibold">No messages yet. Send a message to start!</div>';
        return;
    }

    container.innerHTML = '';
    let lastDate = null;
    const totalMsgs = currentChatMessages.length;

    currentChatMessages.forEach((m, index) => {
        const mDate = new Date(m.timestamp || 0);
        const dateStr = mDate.toDateString();
        
        if (dateStr !== lastDate) {
            const divDate = document.createElement('div');
            divDate.className = 'chat-date-divider';
            const displayDate = mDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
            divDate.innerHTML = `<span>${displayDate}</span>`;
            container.appendChild(divDate);
            lastDate = dateStr;
        }

        const isMe = m.senderId === window.currentUser.uid;
        const isLastMessage = index === totalMsgs - 1;
        
        const div = document.createElement('div');
        div.id = `msg-${m.id}`;
        div.className = `flex w-full ${isMe ? 'justify-end' : 'justify-start'} items-end gap-1.5 relative`;

        let senderAvatarHtml = '';
        let senderNameHtml = '';
        if (window.activeChatIsGroup && !isMe) {
            const senderObj = allUsersCache[m.senderId] || { name: m.senderId, dp: 'https://placehold.co/100' };
            senderAvatarHtml = `<img src="${senderObj.dp}" class="w-6 h-6 rounded-full object-cover mb-1 shrink-0 border border-gray-50 dark:border-white/10">`;
            senderNameHtml = `<span class="text-[10px] font-extrabold text-blue-600 dark:text-blue-400 block mb-0.5 cursor-pointer" onclick="window.openUserProfileDirect('${m.senderId}')">${senderObj.name}</span>`;
        }

        let forwardHeader = m.forwardedFrom ? `
            <div class="flex items-center gap-1 text-[10px] opacity-75 font-bold mb-1 border-b border-black/5 pb-0.5">
                <i class="fas fa-share text-[9px]"></i> Forwarded from <span>${m.forwardedFrom.name}</span>
            </div>` : '';

        let replySnippet = m.replyTo ? `
            <div class="p-1.5 mb-1 bg-black/10 rounded-lg border-l-2 border-white text-[10px] cursor-pointer" onclick="window.scrollToMessage('msg-${m.replyTo.id}')">
                <span class="font-bold text-[10px] block">${m.replyTo.senderName}</span>
                <span class="opacity-80 truncate block">${m.replyTo.textSnippet}</span>
            </div>` : '';

        let content = '';
        if (m.type === 'sticker') {
            content = `
                <div class="chat-sticker-bubble">
                    <img src="${m.stickerUrl}" alt="Sticker" loading="lazy">
                </div>
            `;
        } else if (m.type === 'image') {
            content = `<img src="${m.imageUrl}" class="max-w-[200px] rounded-xl cursor-pointer shadow-sm border border-white/10" onclick="window.previewImage('${m.imageUrl}')">`;
        } else if (m.type === 'audio') {
            content = `
                <div class="flex items-center gap-2 py-0.5">
                    <button class="w-8 h-8 rounded-full ${isMe ? 'bg-white text-blue-600' : 'bg-blue-600 text-white'} flex items-center justify-center text-xs shadow" onclick="window.playAudio(this, '${m.audioUrl}')">
                        <i class="fas fa-play"></i>
                    </button>
                    <span class="text-[11px] font-bold">Voice Note</span>
                </div>`;
        } else {
            let rawText = decryptData(m.text);
            content = `<p class="text-xs font-medium leading-relaxed whitespace-pre-wrap break-words">${formatMessageTextWithMentionsAndLinks(rawText, isMe)}</p>`;
        }

        const timeStr = m.time || (m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
        const editedTag = m.edited ? `<span class="text-[9px] opacity-75 ml-1 italic">(edited)</span>` : '';

        const bubbleClasses = m.type === 'sticker' 
            ? 'chat-sticker-bubble flex flex-col' 
            : `max-w-[82%] rounded-2xl px-3.5 py-2 relative flex flex-col ${isMe ? 'chat-bubble-sent' : 'chat-bubble-received'} cursor-pointer select-none`;

        div.innerHTML = `
            ${senderAvatarHtml}
            <div class="${bubbleClasses}">
                ${senderNameHtml}
                ${forwardHeader}
                ${replySnippet}
                ${content}
                <span class="text-[9px] text-right mt-1 opacity-80 font-bold">${editedTag} ${timeStr} ${isMe ? '<i class="fas fa-check-double text-[8px] ml-1"></i>' : ''}</span>
            </div>
        `;

        let pressTimer;
        const startPress = () => { pressTimer = setTimeout(() => showMessageActionModal(m, isMe), 500); };
        const cancelPress = () => clearTimeout(pressTimer);

        div.addEventListener('mousedown', startPress);
        div.addEventListener('mouseup', cancelPress);
        div.addEventListener('mouseleave', cancelPress);
        div.addEventListener('touchstart', startPress, { passive: true });
        div.addEventListener('touchend', cancelPress);
        div.addEventListener('touchcancel', cancelPress);

        container.appendChild(div);

        if (isLastMessage && isMe && !window.isTargetUnread && !window.activeChatIsGroup && window.activeChatUserId !== window.currentUser.uid && window.activeChatUserId !== OFFICIAL_SYSTEM_UID) {
            const seenDiv = document.createElement('div');
            seenDiv.className = 'w-full flex justify-end px-1 mt-0.5';
            seenDiv.innerHTML = `<span class="msg-seen-status">Seen <i class="fas fa-check-double text-blue-500 ml-0.5"></i></span>`;
            container.appendChild(seenDiv);
        }
    });
    container.scrollTop = container.scrollHeight;
}

function formatMessageTextWithMentionsAndLinks(text, isMe) {
    if (!text) return '';
    let strText = String(text);
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
    let formatted = strText.replace(urlRegex, (url) => {
        const safeUrl = url.startsWith('http') ? url : `https://${url}`;
        return `<a href="javascript:void(0)" onclick="window.triggerScamWarning('${encodeURIComponent(safeUrl)}')" class="web-link">${url}</a>`;
    });
    const mentionRegex = /@([a-zA-Z0-9_]+)/g;
    formatted = formatted.replace(mentionRegex, (match, username) => {
        return `<a href="javascript:void(0)" onclick="window.handleMentionClick('${username}')" class="mention-link">@${username}</a>`;
    });
    return formatted;
}

window.handleMentionClick = async (targetUsername) => {
    const cleanUser = normalizeUsername(targetUsername);

    if (window.currentUser && normalizeUsername(window.currentUser.username) === cleanUser) {
        openDirectChatWithUser({
            uid: window.currentUser.uid, name: 'Saved Messages', username: window.currentUser.username,
            dp: 'https://placehold.co/150/2563eb/ffffff?text=Saved', isSelf: true
        });
        return;
    }

    let matchedUid = null, matchedUser = null;
    for (let uid of Object.keys(allUsersCache)) {
        if (normalizeUsername(allUsersCache[uid].username) === cleanUser || normalizeUsername(uid) === cleanUser) {
            matchedUid = uid; matchedUser = allUsersCache[uid]; break;
        }
    }
    if (!matchedUser) {
        const snap = await get(child(ref(db), `${dbUsersPath}/${cleanUser}`));
        if (snap.exists()) { matchedUid = cleanUser; matchedUser = snap.val(); }
    }
    if (!matchedUser) { window.showToast("Username is invalid", "exclamation-circle", "text-red-400"); return; }

    const safeName = typeof matchedUser.name === 'string' ? matchedUser.name : (matchedUser.username || matchedUid);
    openDirectChatWithUser({
        uid: matchedUid, name: safeName, username: matchedUser.username || cleanUser,
        dp: matchedUser.dp || `https://placehold.co/150/2563eb/ffffff?text=${safeName.charAt(0).toUpperCase()}`,
        isPremium: Boolean(matchedUser.isPremium)
    });
};

async function dispatchMessage(text, img = null, audio = null, stickerUrl = null) {
    if (!window.activeChatId || !window.currentUser) return;

    if (window.activeChatIsGroup) {
        const snap = await get(child(ref(db), `${dbGroupsPath}/${window.activeChatId}`));
        if (snap.exists()) {
            const grp = snap.val();
            const myUid = window.currentUser.uid;
            const isOwner = grp.ownerUid === myUid;
            const isAdmin = Boolean(grp.admins && grp.admins[myUid]);
            const canSend = grp.permissions?.canMemberSendMessages !== false;

            if (!canSend && !isOwner && !isAdmin) {
                return window.showToast("Only admin can send message", "exclamation-circle", "text-red-400");
            }
        }
    }

    const now = Date.now();
    const timeStr = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let textToSend = text ? encryptData(text) : null;
    let msgType = stickerUrl ? 'sticker' : (img ? 'image' : (audio ? 'audio' : 'text'));

    const msgPayload = {
        senderId: window.currentUser.uid, 
        type: msgType,
        text: textToSend, 
        imageUrl: img || null, 
        audioUrl: audio || null,
        stickerUrl: stickerUrl || null,
        timestamp: now, 
        time: timeStr, 
        replyTo: currentReplyTarget
    };

    window.cancelReply();
    await push(ref(db, `${dbChatsPath}/${window.activeChatId}/messages`), msgPayload);

    const previewRaw = stickerUrl ? 'Sticker' : (text || (img ? 'Photo' : 'Voice note'));
    const previewEncrypted = encryptData(previewRaw);
    
    const isSelf = window.activeChatUserId === window.currentUser.uid;
    
    await update(ref(db, `${dbUserChatsPath}/${window.currentUser.uid}/${window.activeChatId}`), {
        id: window.activeChatId, targetUid: window.activeChatUserId,
        name: isSelf ? 'Saved Messages' : window.activeChatUser.name, username: window.activeChatUser.username,
        dp: window.activeChatUser.dp, isGroup: Boolean(window.activeChatIsGroup),
        lastMessage: previewEncrypted, timestamp: now, unread: false
    });

    if (!isSelf && window.activeChatUserId && window.activeChatUserId !== OFFICIAL_SYSTEM_UID) {
        // TICK FIX: Set isVerified based purely on isPremium
        await update(ref(db, `${dbUserChatsPath}/${window.activeChatUserId}/${window.activeChatId}`), {
            id: window.activeChatId, targetUid: window.currentUser.uid,
            name: window.currentUser.name, username: window.currentUser.username,
            dp: window.currentUser.dp, isPremium: Boolean(window.currentUser.isPremium === true),
            lastMessage: previewEncrypted, timestamp: now, unread: true
        });
    }
}

function performLiveSearch(query) {
    const list = document.getElementById('search-results-list');
    if (!list) return;
    const cleanQ = normalizeUsername(query);
    const matches = [];

    for (let uid of Object.keys(allUsersCache)) {
        if (window.currentUser && uid === window.currentUser.uid) continue;
        const u = allUsersCache[uid];
        const name = typeof u.name === 'string' ? u.name : (u.username || uid);
        const username = normalizeUsername(u.username || uid);

        if (name.toLowerCase().includes(cleanQ) || username.includes(cleanQ)) {
            // TICK FIX: Verified tick only exists if user has isPremium === true
            const hasTick = Boolean(uid === OFFICIAL_SYSTEM_UID || u.isPremium === true);
            matches.push({
                uid, name, username: u.username || uid,
                dp: u.dp || `https://placehold.co/150/2563eb/ffffff?text=${name.charAt(0).toUpperCase()}`,
                isVerified: hasTick,
                tickColor: u.verifiedTickColor || 'text-blue-500'
            });
        }
    }

    if (matches.length === 0) {
        list.innerHTML = `<div class="p-8 text-center text-gray-400 text-xs font-semibold">No users found matching "${query}"</div>`;
        return;
    }

    list.innerHTML = '';
    matches.forEach(u => {
        const div = document.createElement('div');
        div.className = 'flex items-center px-5 py-3 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer btn-press border-b border-gray-100 dark:border-white/5 transition-colors';
        
        let vHtml = u.isVerified ? `<i class="fas fa-check-circle ${u.tickColor} text-xs"></i>` : '';
        div.innerHTML = `
            <img src="${u.dp}" class="w-11 h-11 rounded-full object-cover mr-3.5 shadow-sm bg-white border border-gray-50 dark:border-white/10">
            <div class="flex-1 min-w-0">
                <h4 class="font-bold text-sm text-gray-900 dark:text-white flex items-center gap-1">${u.name} ${vHtml}</h4>
                <p class="text-xs text-blue-500">@${u.username}</p>
            </div>
            <i class="fas fa-comment-dots text-gray-300 dark:text-gray-600 text-base"></i>
        `;
        div.onclick = () => {
            addToSearchHistory(u);
            window.closeSearchOverlay();
            openDirectChatWithUser(u);
        };
        list.appendChild(div);
    });
}

function addToSearchHistory(u) {
    let hist = JSON.parse(localStorage.getItem(`search_hist_${window.currentUser?.uid}`) || '[]').filter(x => x.uid !== u.uid);
    hist.unshift(u);
    if (hist.length > 8) hist.pop();
    localStorage.setItem(`search_hist_${window.currentUser?.uid}`, JSON.stringify(hist));
}

function renderSearchHistory() {
    const list = document.getElementById('search-results-list');
    const header = document.getElementById('search-history-header');
    if (!list) return;
    const hist = JSON.parse(localStorage.getItem(`search_hist_${window.currentUser?.uid}`) || '[]');

    if (hist.length === 0) {
        if (header) header.classList.add('hidden');
        list.innerHTML = `<div class="p-8 text-center text-gray-400 text-xs font-semibold">Type name or @username to search contacts</div>`;
        return;
    }
    if (header) header.classList.remove('hidden');
    list.innerHTML = '';
    hist.forEach(u => {
        const div = document.createElement('div');
        div.className = 'flex items-center px-5 py-3 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer btn-press border-b border-gray-100 dark:border-white/5';
        div.innerHTML = `
            <img src="${u.dp}" class="w-11 h-11 rounded-full object-cover mr-3.5 shadow-sm bg-white border border-gray-50 dark:border-white/10">
            <div class="flex-1 min-w-0">
                <h4 class="font-bold text-sm text-gray-900 dark:text-white">${u.name}</h4>
                <p class="text-xs text-blue-500">@${u.username}</p>
            </div>
            <i class="fas fa-history text-gray-300 dark:text-gray-600 text-xs"></i>
        `;
        div.onclick = () => { window.closeSearchOverlay(); openDirectChatWithUser(u); };
        list.appendChild(div);
    });
}

const clearHistBtn = document.getElementById('clear-history-btn');
if (clearHistBtn) {
    clearHistBtn.onclick = () => {
        localStorage.removeItem(`search_hist_${window.currentUser?.uid}`);
        renderSearchHistory();
    };
}

window.openSearchOverlay = () => {
    const overlay = document.getElementById('search-view');
    if (overlay) overlay.classList.remove('hidden');
    document.getElementById('global-search-input')?.focus();
    renderSearchHistory();
};

window.closeSearchOverlay = () => {
    const overlay = document.getElementById('search-view');
    if (overlay) overlay.classList.add('hidden');
    if (document.getElementById('global-search-input')) document.getElementById('global-search-input').value = '';
    document.getElementById('clear-search-btn')?.classList.add('hidden');
};

function openDirectChatWithUser(u) {
    const isSelf = u.uid === window.currentUser?.uid;
    const convId = isSelf ? `saved_${u.uid}` : [window.currentUser.uid, u.uid].sort().join('_');
    const isOfficial = u.uid === OFFICIAL_SYSTEM_UID;
    // TICK REMOVAL FIX: Verified tick only active if isPremium or official
    const hasTick = Boolean(isOfficial || u.isPremium === true);

    openChat({
        id: convId, targetUid: u.uid, name: isSelf ? 'Saved Messages' : u.name,
        username: u.username, dp: isSelf ? 'https://placehold.co/150/2563eb/ffffff?text=Saved' : u.dp,
        isVerified: hasTick, isSelf: isSelf, status: isSelf ? 'Saved' : 'online'
    });
}

window.contactSupportInApp = async () => {
    const cleanUser = 'chatrixsupport';
    let matchedUid = null, matchedUser = null;

    for (let uid of Object.keys(allUsersCache)) {
        if (normalizeUsername(allUsersCache[uid].username) === cleanUser) {
            matchedUid = uid; matchedUser = allUsersCache[uid]; break;
        }
    }
    if (!matchedUser) {
        const snap = await get(child(ref(db), `${dbUsersPath}/${cleanUser}`));
        if (snap.exists()) { matchedUid = cleanUser; matchedUser = snap.val(); }
    }
    
    if (matchedUser) {
        openDirectChatWithUser({ uid: matchedUid, name: matchedUser.name, username: matchedUser.username, dp: matchedUser.dp, isPremium: true });
    } else {
        openDirectChatWithUser({ uid: 'ChatrixSupport', name: 'Chatrix Support', username: 'ChatrixSupport', dp: 'https://placehold.co/150/0284c7/ffffff?text=Help', isPremium: true });
    }
};

function populateUserData() {
    if (!window.currentUser) return;
    // TICK REMOVAL FIX: If isPremium is false, tick is completely stripped
    const isPrem = window.currentUser.isPremium === true;
    const tickColor = window.currentUser.verifiedTickColor || 'text-blue-500';
    const badgeHtml = isPrem ? `<i class="fas fa-check-circle ${tickColor} text-xs ml-1"></i>` : '';

    const setTopName = document.getElementById('settings-top-name');
    if (setTopName) setTopName.innerHTML = `${window.currentUser.name} ${badgeHtml}`;
    const setTopUser = document.getElementById('settings-top-username');
    if (setTopUser) setTopUser.textContent = `@${window.currentUser.username}`;
    const setTopDp = document.getElementById('settings-top-dp');
    if (setTopDp) setTopDp.src = window.currentUser.dp;

    const profName = document.getElementById('profile-name');
    if (profName) profName.innerHTML = `${window.currentUser.name} ${badgeHtml}`;
    const profDp = document.getElementById('profile-dp');
    if (profDp) profDp.src = window.currentUser.dp;
    const profUser = document.getElementById('profile-username-display');
    if (profUser) profUser.textContent = `@${window.currentUser.username}`;
    const profBday = document.getElementById('profile-birthday-display');
    if (profBday) profBday.textContent = window.currentUser.birthday || 'Add Birthday';
    const profBio = document.getElementById('profile-bio-display');
    if (profBio) profBio.textContent = window.currentUser.bio || 'Trust once lost is never found again.';

    applyProfileCoverStyle(window.currentUser, 'settings');
    applyProfileCoverStyle(window.currentUser, 'my-profile');
    if (typeof window.renderMyProfilePosts === 'function') window.renderMyProfilePosts();
}

// SUPPORT SOLID, GRADIENT, AND PRESETS
function applyProfileCoverStyle(user, prefix) {
    const header = document.getElementById(`${prefix}-header-bg`);
    const pattern = document.getElementById(`${prefix}-pattern-layer`);
    if (!header) return;

    if (user.isPremium && (user.profileGradient || user.profilePatternIcon)) {
        const grad = user.profileGradient || '';
        let cssBackground = '';

        if (GRADIENT_MAP[grad]) {
            cssBackground = GRADIENT_MAP[grad];
        } else if (grad.startsWith('linear-gradient')) {
            cssBackground = grad;
        } else if (grad.startsWith('#') || grad.startsWith('rgb')) {
            cssBackground = grad;
        } else {
            cssBackground = 'linear-gradient(to bottom, #1f2937, #111827)';
        }
        
        header.style.background = cssBackground;
        
        if(prefix === 'settings') {
             header.className = `flex flex-col items-center pt-4 pb-6 rounded-3xl transition-all duration-300 text-white shrink-0 border border-transparent relative overflow-hidden`;
        } else if(prefix === 'overlay-profile') {
             header.className = `relative overflow-hidden px-6 pt-6 pb-8 transition-all duration-300 shrink-0 text-white border-transparent`;
        } else {
             header.className = `relative overflow-hidden px-6 pt-6 pb-8 text-white transition-all duration-300 border-transparent`;
        }
        
        if (pattern && user.profilePatternIcon) {
            let str = '';
            for (let i = 0; i < 28; i++) {
                str += `<span class="opacity-40 select-none monochrome-emoji text-3xl m-2">${user.profilePatternIcon}</span>`;
            }
            pattern.innerHTML = str;
        } else if(pattern) {
            pattern.innerHTML = '';
        }
    } else {
        header.style.background = '';
        if(prefix === 'settings') {
             header.className = 'flex flex-col items-center mb-0 pt-2 rounded-3xl p-4 transition-all duration-300 bg-white dark:bg-[#1e293b] border border-gray-100 dark:border-white/5 shrink-0 relative overflow-hidden text-gray-900 dark:text-white';
        } else if(prefix === 'overlay-profile') {
             header.className = `relative overflow-hidden bg-white dark:bg-[#1e293b] px-6 pt-6 pb-8 transition-all duration-300 shrink-0 border-b border-gray-100 dark:border-white/5`;
        } else {
             header.className = 'relative overflow-hidden bg-white dark:bg-[#1e293b] border-b border-gray-100 dark:border-transparent px-6 pt-6 pb-8 transition-all duration-300 text-gray-900 dark:text-white';
        }
        if (pattern) pattern.innerHTML = '';
    }
}

function applyStoredAppearance() {
    const config = JSON.parse(localStorage.getItem('chatrix_appearance') || '{}');
    const isDark = config.darkMode === true;
    if (isDark) {
        document.documentElement.classList.add('dark', 'dark-mode');
        document.documentElement.style.setProperty('--app-bg', '#0f172a');
        document.documentElement.style.setProperty('--app-card-bg', '#1e293b');
        document.documentElement.style.setProperty('--app-card-subtle', '#182234');
        document.documentElement.style.setProperty('--app-text', '#f8fafc');
        document.documentElement.style.setProperty('--app-text-muted', '#94a3b8');
        document.documentElement.style.setProperty('--app-border', '#334155');
        document.documentElement.style.setProperty('--chat-bg-color', '#0b0f19');
    } else {
        document.documentElement.classList.remove('dark', 'dark-mode');
        document.documentElement.style.setProperty('--app-bg', '#ffffff');
        document.documentElement.style.setProperty('--app-card-bg', '#ffffff');
        document.documentElement.style.setProperty('--app-card-subtle', '#f8fafc');
        document.documentElement.style.setProperty('--app-text', '#0f172a');
        document.documentElement.style.setProperty('--app-text-muted', '#64748b');
        document.documentElement.style.setProperty('--app-border', '#f1f5f9');
        document.documentElement.style.setProperty('--chat-bg-color', '#ffffff');
    }
    if (config.tabColor) document.documentElement.style.setProperty('--tab-color', config.tabColor);
    if (config.msgColor) document.documentElement.style.setProperty('--msg-sent-bg', config.msgColor);
    if (config.wallpaper) document.documentElement.style.setProperty('--chat-wallpaper', `url(${config.wallpaper})`);
    else document.documentElement.style.setProperty('--chat-wallpaper', 'none');
}

// -------------------------------------------------------------
// DUAL COLOR PICKER (1 COLOR = SOLID, 2 COLORS = GRADIENT)
// -------------------------------------------------------------
let tempSelectedGradient = '';
let tempSelectedIcon = '';

window.openAdvancedColorPicker = () => {
    tempSelectedGradient = window.currentUser.profileGradient || '';
    tempSelectedIcon = window.currentUser.profilePatternIcon || '';
    
    document.getElementById('color-preview-dp').src = window.currentUser.dp;
    document.getElementById('color-preview-name').innerText = window.currentUser.name;
    
    const previewBg = document.getElementById('color-preview-bg');
    if (tempSelectedGradient) {
        previewBg.style.background = GRADIENT_MAP[tempSelectedGradient] || tempSelectedGradient;
        previewBg.className = `relative overflow-hidden px-6 pt-6 pb-12 transition-all duration-300 rounded-b-[35px] shadow-sm border-b border-transparent text-white`;
    } else {
        previewBg.style.background = '';
        previewBg.className = `relative overflow-hidden px-6 pt-6 pb-12 transition-all duration-300 rounded-b-[35px] shadow-sm border-b border-gray-100 dark:border-transparent bg-white dark:bg-[#1e293b]`;
    }

    document.querySelectorAll('.color-swatch').forEach(btn => {
        if(btn.dataset.grad === tempSelectedGradient) btn.classList.add('active');
        else btn.classList.remove('active');
    });

    const patternLayer = document.getElementById('color-preview-pattern-layer');
    if(tempSelectedIcon) {
        let str = '';
        for(let i=0; i<28; i++) str += `<span class="opacity-40 select-none monochrome-emoji text-3xl m-2">${tempSelectedIcon}</span>`;
        if(patternLayer) patternLayer.innerHTML = str;
        document.getElementById('current-icon-status').innerText = tempSelectedIcon;
    } else {
        if(patternLayer) patternLayer.innerHTML = '';
        document.getElementById('current-icon-status').innerText = 'Off';
    }

    const overlay = document.getElementById('profile-color-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.style.display = 'flex';
    }
};

window.closeAdvancedColorPicker = () => {
    const overlay = document.getElementById('profile-color-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
        overlay.style.display = 'none';
    }
};

window.updateDualCustomColor = function() {
    profileTempColor1 = document.getElementById('custom-color-1')?.value || '#3b82f6';
    profileTempColor2 = document.getElementById('custom-color-2')?.value || '';

    const hex1 = document.getElementById('hex-1-display');
    const hex2 = document.getElementById('hex-2-display');
    const label = document.getElementById('custom-color-mode-label');
    const previewBg = document.getElementById('color-preview-bg');

    if (hex1) hex1.innerText = profileTempColor1;
    if (hex2) hex2.innerText = profileTempColor2 || 'None (Solid)';

    if (profileTempColor2 && profileTempColor2 !== profileTempColor1) {
        tempSelectedGradient = `linear-gradient(135deg, ${profileTempColor1} 0%, ${profileTempColor2} 100%)`;
        if (label) label.innerText = "Mode: 2 Colors (Gradient)";
    } else {
        tempSelectedGradient = profileTempColor1;
        if (label) label.innerText = "Mode: 1 Color (Solid)";
    }

    if (previewBg) {
        previewBg.style.background = tempSelectedGradient;
        previewBg.className = `relative overflow-hidden px-6 pt-6 pb-12 transition-all duration-300 rounded-b-[35px] shadow-sm border-b border-transparent text-white`;
    }
    document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
};

window.clearColor2 = function() {
    profileTempColor2 = '';
    const hex2 = document.getElementById('hex-2-display');
    if (hex2) hex2.innerText = 'None (Solid)';
    window.updateDualCustomColor();
};

window.selectLiveColor = (btn) => {
    document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    tempSelectedGradient = btn.dataset.grad;
    const previewBg = document.getElementById('color-preview-bg');
    
    if(tempSelectedGradient) {
        previewBg.style.background = GRADIENT_MAP[tempSelectedGradient] || tempSelectedGradient;
        previewBg.className = `relative overflow-hidden px-6 pt-6 pb-12 transition-all duration-300 rounded-b-[35px] shadow-sm border-b border-transparent text-white`;
    } else {
        previewBg.style.background = '#4b5563';
        previewBg.className = `relative overflow-hidden px-6 pt-6 pb-12 transition-all duration-300 rounded-b-[35px] shadow-sm border-b border-transparent text-white`;
    }
};

window.selectProfileIcon = (icon) => {
    tempSelectedIcon = icon;
    const patternLayer = document.getElementById('color-preview-pattern-layer');
    if(icon) {
        let str = '';
        for(let i=0; i<28; i++) str += `<span class="opacity-40 select-none monochrome-emoji text-3xl m-2">${icon}</span>`;
        if(patternLayer) patternLayer.innerHTML = str;
        document.getElementById('current-icon-status').innerText = icon;
    } else {
        if(patternLayer) patternLayer.innerHTML = '';
        document.getElementById('current-icon-status').innerText = 'Off';
    }
};

window.selectTickColor = async (colorClass) => {
    if (!window.currentUser.isPremium) {
        window.showToast("Premium feature!", "lock", "text-amber-500");
        return;
    }
    window.currentUser.verifiedTickColor = colorClass;
    await update(ref(db, `${dbUsersPath}/${window.currentUser.uid}`), { verifiedTickColor: colorClass });
    localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));
    populateUserData();
    window.showToast("Verified tick color updated!");
    window.closeAdvancedColorPicker();
};

window.applyAdvancedProfileColor = async () => {
    if ((tempSelectedGradient || tempSelectedIcon) && !window.currentUser.isPremium) {
        window.showToast('Premium is required for colors', 'lock', 'text-amber-500');
        window.closeAdvancedColorPicker();
        window.openPremiumModal();
        return;
    }

    window.currentUser.profileGradient = tempSelectedGradient;
    window.currentUser.profilePatternIcon = tempSelectedIcon;
    
    await update(ref(db, `${dbUsersPath}/${window.currentUser.uid}`), { 
        profileGradient: tempSelectedGradient,
        profilePatternIcon: tempSelectedIcon 
    });
    
    localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));
    populateUserData();
    window.showToast("Profile style updated!");
    window.closeAdvancedColorPicker();
};

window.resetAdvancedProfileColor = () => {
    tempSelectedGradient = '';
    tempSelectedIcon = '';
    const previewBg = document.getElementById('color-preview-bg');
    previewBg.style.background = '';
    previewBg.className = `relative overflow-hidden px-6 pt-6 pb-12 transition-all duration-300 rounded-b-[35px] shadow-sm border-b border-gray-100 dark:border-transparent bg-white dark:bg-[#1e293b]`;
    document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
    document.getElementById('color-preview-pattern-layer').innerHTML = '';
    document.getElementById('current-icon-status').innerText = 'Off';
};

// -------------------------------------------------------------
// STICKER STUDIO & STICKER KEYBOARD ENGINE
// -------------------------------------------------------------

window.openStickerStudio = function() {
    const overlay = document.getElementById('sticker-studio-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.style.display = 'flex';
        window.switchStudioTab('my');
    }
};

window.closeStickerStudio = function() {
    const overlay = document.getElementById('sticker-studio-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
        overlay.style.display = 'none';
    }
};

window.switchStudioTab = function(tab) {
    const myView = document.getElementById('studio-my-view');
    const discoverView = document.getElementById('studio-discover-view');
    const btnMy = document.getElementById('studio-tab-my');
    const btnDiscover = document.getElementById('studio-tab-discover');

    if (tab === 'my') {
        myView.classList.remove('hidden');
        discoverView.classList.add('hidden');
        btnMy.className = "px-4 py-1.5 rounded-full bg-white dark:bg-white/20 text-xs font-bold text-gray-900 dark:text-white shadow-sm transition-all";
        btnDiscover.className = "px-4 py-1.5 rounded-full text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-all";
        loadUserStickerPacks();
    } else {
        myView.classList.add('hidden');
        discoverView.classList.remove('hidden');
        btnDiscover.className = "px-4 py-1.5 rounded-full bg-white dark:bg-white/20 text-xs font-bold text-gray-900 dark:text-white shadow-sm transition-all";
        btnMy.className = "px-4 py-1.5 rounded-full text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-all";
        loadDiscoverStickerPacks();
    }
};

window.promptCreateStickerPack = async function() {
    const packName = prompt("Enter a name for your Sticker Pack:");
    if (!packName || !packName.trim() || !window.currentUser) return;

    const packId = 'pack_' + Date.now();
    const newPack = {
        id: packId,
        name: packName.trim(),
        authorUid: window.currentUser.uid,
        authorName: window.currentUser.name || 'User',
        stickers: {},
        createdAt: Date.now()
    };

    await set(ref(db, `${dbStickerPacksPath}/${packId}`), newPack);
    await set(ref(db, `${dbUsersPath}/${window.currentUser.uid}/myPacks/${packId}`), true);

    window.showToast("Sticker pack created!", "check-circle");
    loadUserStickerPacks();
};

async function loadUserStickerPacks() {
    const listEl = document.getElementById('my-sticker-packs-list');
    if (!listEl || !window.currentUser) return;
    listEl.innerHTML = `<div class="p-6 text-center text-xs text-gray-400"><i class="fas fa-spinner fa-spin mr-1"></i> Loading packs...</div>`;

    const myPacksSnap = await get(child(ref(db), `${dbUsersPath}/${window.currentUser.uid}/myPacks`));
    const myPackIds = myPacksSnap.exists() ? Object.keys(myPacksSnap.val()) : [];

    const allPacksSnap = await get(ref(db, dbStickerPacksPath));
    const allPacks = allPacksSnap.exists() ? allPacksSnap.val() : {};

    listEl.innerHTML = '';
    const userPacks = [];

    myPackIds.forEach(id => {
        if (allPacks[id]) userPacks.push(allPacks[id]);
    });

    if (userPacks.length === 0) {
        listEl.innerHTML = `
            <div class="bg-white dark:bg-slate-800 rounded-2xl p-6 text-center border border-gray-100 dark:border-white/5">
                <i class="fas fa-box-open text-3xl text-gray-400 mb-2"></i>
                <p class="text-xs font-bold text-gray-700 dark:text-gray-200">No sticker packs in collection</p>
                <p class="text-[11px] text-gray-400 mt-1 mb-3">Create your own pack or discover community stickers.</p>
                <button onclick="window.promptCreateStickerPack()" class="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold btn-press">Create Pack</button>
            </div>
        `;
        return;
    }

    userPacks.forEach(pack => {
        const stickersList = pack.stickers ? Object.values(pack.stickers) : [];
        const card = document.createElement('div');
        card.className = "bg-white dark:bg-slate-800 rounded-2xl p-3.5 border border-gray-100 dark:border-white/5 flex items-center justify-between shadow-sm cursor-pointer hover:border-blue-500 transition-all btn-press";
        card.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-xl bg-pink-50 dark:bg-pink-900/20 text-pink-500 flex items-center justify-center text-xl shrink-0 overflow-hidden">
                    ${stickersList[0] ? `<img src="${stickersList[0]}" class="w-full h-full object-cover">` : '<i class="fas fa-icons"></i>'}
                </div>
                <div>
                    <h4 class="font-extrabold text-xs text-gray-900 dark:text-white">${pack.name}</h4>
                    <p class="text-[10px] text-gray-400 font-medium">${stickersList.length} stickers</p>
                </div>
            </div>
            <i class="fas fa-chevron-right text-gray-300 dark:text-gray-600 text-xs"></i>
        `;
        card.onclick = () => window.openStickerPackDetail(pack.id);
        listEl.appendChild(card);
    });
}

async function loadDiscoverStickerPacks() {
    const listEl = document.getElementById('discover-sticker-packs-list');
    if (!listEl || !window.currentUser) return;
    listEl.innerHTML = `<div class="p-6 text-center text-xs text-gray-400"><i class="fas fa-spinner fa-spin mr-1"></i> Loading public stickers...</div>`;

    const myPacksSnap = await get(child(ref(db), `${dbUsersPath}/${window.currentUser.uid}/myPacks`));
    const myPackIds = myPacksSnap.exists() ? myPacksSnap.val() : {};

    const snap = await get(ref(db, dbStickerPacksPath));
    if (!snap.exists()) {
        listEl.innerHTML = `<div class="p-6 text-center text-xs text-gray-400">No public sticker packs yet.</div>`;
        return;
    }

    const allPacks = snap.val();
    listEl.innerHTML = '';

    Object.values(allPacks).forEach(pack => {
        const stickersList = pack.stickers ? Object.values(pack.stickers) : [];
        const isAdded = Boolean(myPackIds[pack.id]);
        const card = document.createElement('div');
        card.className = "bg-white dark:bg-slate-800 rounded-2xl p-3.5 border border-gray-100 dark:border-white/5 flex items-center justify-between shadow-sm";
        card.innerHTML = `
            <div class="flex items-center gap-3 cursor-pointer" onclick="window.openStickerPackDetail('${pack.id}')">
                <div class="w-12 h-12 rounded-xl bg-purple-50 dark:bg-purple-900/20 text-purple-500 flex items-center justify-center text-xl shrink-0 overflow-hidden">
                    ${stickersList[0] ? `<img src="${stickersList[0]}" class="w-full h-full object-cover">` : '<i class="fas fa-icons"></i>'}
                </div>
                <div>
                    <h4 class="font-extrabold text-xs text-gray-900 dark:text-white">${pack.name}</h4>
                    <p class="text-[10px] text-gray-400 font-medium">By @${pack.authorName || 'user'} • ${stickersList.length} stickers</p>
                </div>
            </div>
            <button onclick="window.toggleAddPackToCollection('${pack.id}')" class="px-3.5 py-1.5 rounded-full text-xs font-bold ${isAdded ? 'bg-red-50 text-red-500 dark:bg-red-950/30' : 'bg-blue-600 text-white'} btn-press">
                ${isAdded ? 'Remove' : 'Add Pack'}
            </button>
        `;
        listEl.appendChild(card);
    });
}

window.toggleAddPackToCollection = async function(packId) {
    if (!window.currentUser) return;
    const refPath = `${dbUsersPath}/${window.currentUser.uid}/myPacks/${packId}`;
    const snap = await get(child(ref(db), refPath));
    if (snap.exists()) {
        await remove(ref(db, refPath));
        window.showToast("Pack removed from collection");
    } else {
        await set(ref(db, refPath), true);
        window.showToast("Pack added to My Stickers!");
    }
    loadDiscoverStickerPacks();
};

window.openStickerPackDetail = async function(packId) {
    currentActivePackId = packId;
    const modal = document.getElementById('sticker-pack-detail-modal');
    modal.classList.remove('hidden');
    modal.style.display = 'flex';

    const snap = await get(child(ref(db), `${dbStickerPacksPath}/${packId}`));
    if (!snap.exists()) return;
    const pack = snap.val();

    document.getElementById('pack-detail-title').innerText = pack.name;
    const stickersObj = pack.stickers || {};
    const stickerKeys = Object.keys(stickersObj);
    document.getElementById('pack-detail-count').innerText = `${stickerKeys.length} Stickers`;

    const makeBtn = document.getElementById('pack-detail-make-btn');
    if (makeBtn) {
        makeBtn.style.display = (pack.authorUid === window.currentUser?.uid) ? 'flex' : 'none';
    }

    const grid = document.getElementById('pack-detail-stickers-grid');
    grid.innerHTML = '';

    if (stickerKeys.length === 0) {
        grid.innerHTML = `<div class="col-span-4 text-center py-10 text-gray-400 text-xs">No stickers in this pack yet. Click "Make Sticker" to start.</div>`;
        return;
    }

    stickerKeys.forEach(sKey => {
        const url = stickersObj[sKey];
        const item = document.createElement('div');
        item.className = "sticker-item-box relative group";
        item.innerHTML = `
            <img src="${url}" alt="Sticker">
            ${pack.authorUid === window.currentUser?.uid ? `
                <button class="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full text-[9px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" onclick="event.stopPropagation(); window.deleteStickerFromPack('${sKey}')">
                    <i class="fas fa-times"></i>
                </button>
            ` : ''}
        `;
        grid.appendChild(item);
    });
};

window.closeStickerPackDetail = function() {
    const modal = document.getElementById('sticker-pack-detail-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
};

window.deleteStickerFromPack = async function(stickerKey) {
    if (!currentActivePackId) return;
    await remove(ref(db, `${dbStickerPacksPath}/${currentActivePackId}/stickers/${stickerKey}`));
    window.showToast("Sticker removed");
    window.openStickerPackDetail(currentActivePackId);
};

// 512x512 CANVAS STICKER MAKER
window.openStickerMakerModal = function() {
    const modal = document.getElementById('sticker-maker-modal');
    modal.classList.remove('hidden');
    modal.style.display = 'flex';

    stickerCanvas = document.getElementById('sticker-draw-canvas');
    stickerCtx = stickerCanvas.getContext('2d');
    stickerCtx.clearRect(0, 0, 512, 512);

    setupStickerDrawingEvents();
};

window.closeStickerMakerModal = function() {
    const modal = document.getElementById('sticker-maker-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
};

function setupStickerDrawingEvents() {
    if (!stickerCanvas) return;

    function getCoords(e) {
        const rect = stickerCanvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const scaleX = 512 / rect.width;
        const scaleY = 512 / rect.height;
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY
        };
    }

    function startDraw(e) {
        if (!stickerBrushActive) return;
        isStickerPainting = true;
        const { x, y } = getCoords(e);
        stickerCtx.beginPath();
        stickerCtx.moveTo(x, y);
    }

    function draw(e) {
        if (!isStickerPainting || !stickerBrushActive) return;
        const { x, y } = getCoords(e);
        const color = document.getElementById('sticker-brush-color')?.value || '#3b82f6';
        const size = document.getElementById('sticker-brush-size')?.value || 8;

        stickerCtx.strokeStyle = color;
        stickerCtx.lineWidth = size;
        stickerCtx.lineCap = 'round';
        stickerCtx.lineJoin = 'round';
        stickerCtx.lineTo(x, y);
        stickerCtx.stroke();
    }

    function stopDraw() {
        if (isStickerPainting) {
            stickerCtx.closePath();
            isStickerPainting = false;
        }
    }

    stickerCanvas.onmousedown = startDraw;
    stickerCanvas.onmousemove = draw;
    window.onmouseup = stopDraw;

    stickerCanvas.ontouchstart = startDraw;
    stickerCanvas.ontouchmove = draw;
    stickerCanvas.ontouchend = stopDraw;
}

window.toggleStickerBrush = function() {
    stickerBrushActive = !stickerBrushActive;
    const btn = document.getElementById('sticker-brush-btn');
    if (btn) {
        btn.className = stickerBrushActive
            ? "flex-1 py-2 rounded-xl bg-blue-600 text-white text-xs font-bold flex items-center justify-center gap-1 btn-press"
            : "flex-1 py-2 rounded-xl bg-white/10 text-white text-xs font-bold flex items-center justify-center gap-1 btn-press";
    }
};

window.clearStickerCanvas = function() {
    if (stickerCtx) stickerCtx.clearRect(0, 0, 512, 512);
};

window.promptAddStickerText = function() {
    const text = prompt("Enter text to add onto canvas:");
    if (!text || !text.trim() || !stickerCtx) return;

    const color = document.getElementById('sticker-brush-color')?.value || '#ffffff';
    stickerCtx.font = 'bold 44px Inter, sans-serif';
    stickerCtx.fillStyle = color;
    stickerCtx.textAlign = 'center';
    stickerCtx.textBaseline = 'middle';
    stickerCtx.fillText(text.trim(), 256, 256);
};

// Sticker File Importer (ONLY Image / GIF, No video, No audio, max 5MB)
const stickerFileInp = document.getElementById('sticker-import-file');
if (stickerFileInp) {
    stickerFileInp.onchange = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) {
            window.showToast("Sticker file exceeds 5MB limit", "exclamation-circle", "text-red-400");
            e.target.value = '';
            return;
        }

        if (!file.type.startsWith('image/')) {
            window.showToast("Only Image or GIF formats allowed", "exclamation-circle", "text-red-400");
            e.target.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const hRatio = 512 / img.width;
                const vRatio = 512 / img.height;
                const ratio = Math.min(hRatio, vRatio);
                const shiftX = (512 - img.width * ratio) / 2;
                const shiftY = (512 - img.height * ratio) / 2;
                stickerCtx.drawImage(img, 0, 0, img.width, img.height, shiftX, shiftY, img.width * ratio, img.height * ratio);
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    };
}

window.saveCreatedSticker = async function() {
    if (!stickerCanvas || !currentActivePackId) return;

    const btn = document.getElementById('done-sticker-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Saving...";
    }

    try {
        const dataUrl = stickerCanvas.toDataURL('image/png');
        const sKey = 'stk_' + Date.now();

        await set(ref(db, `${dbStickerPacksPath}/${currentActivePackId}/stickers/${sKey}`), dataUrl);
        window.showToast("Sticker added to pack!", "check-circle");
        window.closeStickerMakerModal();
        window.openStickerPackDetail(currentActivePackId);
    } catch(err) {
        window.showToast("Failed to save sticker", "exclamation-circle", "text-red-400");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Done";
        }
    }
};

// CHAT STICKER KEYBOARD DRAWER (4X4 GRID)
window.toggleStickerDrawer = function() {
    const drawer = document.getElementById('chat-sticker-drawer');
    if (!drawer) return;
    if (drawer.classList.contains('hidden')) {
        drawer.classList.remove('hidden');
        drawer.style.display = 'flex';
        loadChatStickerDrawer();
    } else {
        window.closeStickerDrawer();
    }
};

window.closeStickerDrawer = function() {
    const drawer = document.getElementById('chat-sticker-drawer');
    if (drawer) {
        drawer.classList.add('hidden');
        drawer.style.display = 'none';
    }
};

async function loadChatStickerDrawer() {
    const tabsContainer = document.getElementById('sticker-drawer-packs-tabs');
    const gridContainer = document.getElementById('sticker-drawer-grid');
    if (!tabsContainer || !gridContainer || !window.currentUser) return;

    tabsContainer.innerHTML = '';
    gridContainer.innerHTML = '';

    const myPacksSnap = await get(child(ref(db), `${dbUsersPath}/${window.currentUser.uid}/myPacks`));
    const myPackIds = myPacksSnap.exists() ? Object.keys(myPacksSnap.val()) : [];

    const allPacksSnap = await get(ref(db, dbStickerPacksPath));
    const allPacks = allPacksSnap.exists() ? allPacksSnap.val() : {};

    const availablePacks = [];
    myPackIds.forEach(id => {
        if (allPacks[id]) availablePacks.push(allPacks[id]);
    });

    if (availablePacks.length === 0) {
        gridContainer.innerHTML = `<div class="col-span-4 text-center py-8 text-xs text-gray-400">No stickers added. Open Sticker Studio to create or add packs!</div>`;
        return;
    }

    availablePacks.forEach((pack, index) => {
        const tabBtn = document.createElement('button');
        tabBtn.className = `px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap btn-press ${index === 0 ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-slate-800 text-gray-500'}`;
        tabBtn.innerText = pack.name;
        tabBtn.onclick = () => {
            tabsContainer.querySelectorAll('button').forEach(b => {
                b.className = 'px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap btn-press bg-gray-100 dark:bg-slate-800 text-gray-500';
            });
            tabBtn.className = 'px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap btn-press bg-blue-600 text-white';
            renderStickerGrid4x4(pack);
        };
        tabsContainer.appendChild(tabBtn);
    });

    renderStickerGrid4x4(availablePacks[0]);
}

function renderStickerGrid4x4(pack) {
    const grid = document.getElementById('sticker-drawer-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const stickersObj = pack.stickers || {};
    const urls = Object.values(stickersObj);

    if (urls.length === 0) {
        grid.innerHTML = `<div class="col-span-4 text-center py-8 text-xs text-gray-400">This pack has no stickers yet.</div>`;
        return;
    }

    urls.forEach(url => {
        const item = document.createElement('div');
        item.className = "sticker-item-box";
        item.innerHTML = `<img src="${url}" alt="Sticker">`;
        item.onclick = () => {
            dispatchMessage('', null, null, url);
            window.closeStickerDrawer();
        };
        grid.appendChild(item);
    });
}

// -------------------------------------------------------------
// PREMIUM FLOW & MODALS
// -------------------------------------------------------------
window.openPremiumModal = () => {
    const html = `
        <div class="text-center mb-4">
            <div class="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto text-xl mb-2 shadow-sm">
                <i class="fas fa-star"></i>
            </div>
            <h3 class="text-base font-black text-gray-900">Chatrix Premium</h3>
            <p class="text-[11px] text-gray-500 font-medium">Verified badge & exclusive profile colors.</p>
        </div>
        
        <div class="bg-gray-50 p-3 rounded-2xl border border-gray-100 mb-4 flex flex-col items-center">
            <p class="text-xs font-bold text-gray-800 mb-2">Scan & Pay <span class="text-blue-600">₹30</span></p>
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=upi://pay?pa=sunnypro@fam&pn=Chatrix%20Premium&am=30.00&cu=INR" class="w-32 h-32 rounded-xl shadow-sm mb-3 bg-white p-1 border border-gray-200">
            <p class="text-[10px] text-gray-500 font-medium bg-white px-2.5 py-1.5 rounded-lg border border-gray-200 flex items-center gap-2">
                UPI ID: <span class="font-bold text-gray-900 select-all">sunnypro@fam</span>
            </p>
        </div>

        <div class="mb-4">
            <label class="block text-[10px] font-bold text-gray-400 uppercase mb-1">Enter 12-Digit UTR Number</label>
            <input type="text" id="premium-utr-input" placeholder="e.g. 312345678901" class="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl text-xs font-bold outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 transition-all text-gray-900 text-center tracking-widest">
        </div>

        <div class="flex gap-2">
            <button onclick="window.closeModal(this)" class="flex-1 py-3 bg-gray-100 text-gray-700 rounded-xl font-bold text-xs btn-press">Cancel</button>
            <button onclick="window.submitPremiumUtr(this)" class="flex-[2] py-3 bg-blue-600 text-white rounded-xl font-bold text-xs btn-press shadow-md">Submit Payment</button>
        </div>
    `;
    renderModalHTML(html);
};

window.submitPremiumUtr = async (btn) => {
    // RATE LIMIT CHECK: 5 Hour ban stored directly into Firebase Database
    const isRateLimited = await checkPremiumRequestRateLimit();
    if (isRateLimited) return;

    const modal = btn.closest('.bg-white');
    const utr = modal.querySelector('#premium-utr-input').value.trim();
    if (!utr || utr.length < 6) return window.showToast('Please enter a valid UTR number', 'exclamation-circle', 'text-red-400');
    
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    
    const welcomeId = [OFFICIAL_SYSTEM_UID, window.currentUser.uid].sort().join('_');
    const now = Date.now();
    const timeStr = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    await push(ref(db, `${dbChatsPath}/${welcomeId}/messages`), {
        senderId: OFFICIAL_SYSTEM_UID,
        text: encryptData(`Premium Request Received! 🌟\n\nUTR: ${utr}\nAmount: ₹30\n\nYour request has been sent to the admin for verification. If approved, your account will be upgraded to Premium. We will alert you here upon approval or rejection.`),
        timestamp: now, time: timeStr
    });

    await update(ref(db, `${dbUserChatsPath}/${window.currentUser.uid}/${welcomeId}`), {
        id: welcomeId, targetUid: OFFICIAL_SYSTEM_UID, name: 'Chatrix', username: 'chatrix_official',
        dp: 'https://placehold.co/150/2563eb/ffffff?text=CX', isVerified: true, isOfficial: true,
        lastMessage: encryptData(`Premium request received (UTR: ${utr})`), timestamp: now, unread: true
    });

    window.showToast("Request submitted for review!");
    window.closeModal(btn);
};

window.promptEditBirthday = () => {
    const html = `
        <h3 class="text-base font-bold mb-2">Edit Birthday</h3>
        <input type="date" id="edit-bday-input" value="${window.currentUser.birthday || ''}" class="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl text-xs font-medium outline-none mb-3">
        <div class="flex gap-2">
            <button onclick="window.closeModal(this)" class="flex-1 py-2.5 bg-gray-100 rounded-xl font-bold text-xs btn-press">Cancel</button>
            <button onclick="window.saveBirthday(this)" class="flex-1 py-2.5 bg-blue-600 text-white rounded-xl font-bold text-xs btn-press">Save</button>
        </div>
    `;
    renderModalHTML(html);
};

window.saveBirthday = async (btn) => {
    const modal = btn.closest('.bg-white');
    const bday = modal.querySelector('#edit-bday-input').value;
    window.currentUser.birthday = bday;
    await update(ref(db, `${dbUsersPath}/${window.currentUser.uid}`), { birthday: bday });
    localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));
    populateUserData();
    window.showToast("Birthday updated");
    window.closeModal(btn);
};

window.openModernEditModal = (field) => {
    let currentValue = window.currentUser[field] || '';
    let title = field.charAt(0).toUpperCase() + field.slice(1);
    const html = `
        <h3 class="text-base font-bold mb-2">Edit ${title}</h3>
        <input type="text" id="edit-field-input" value="${currentValue}" class="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl text-xs font-medium outline-none mb-3">
        <div class="flex gap-2">
            <button onclick="window.closeModal(this)" class="flex-1 py-2.5 bg-gray-100 rounded-xl font-bold text-xs btn-press">Cancel</button>
            <button onclick="window.saveModernEdit('${field}', this)" class="flex-1 py-2.5 bg-blue-600 text-white rounded-xl font-bold text-xs btn-press">Save</button>
        </div>
    `;
    renderModalHTML(html);
};

window.saveModernEdit = async (field, btn) => {
    const modal = btn.closest('.bg-white');
    const newVal = modal.querySelector('#edit-field-input').value.trim();
    if (!newVal) return;

    if (field === 'username') {
        if (/\s/.test(newVal)) {
            return window.showToast("Spaces are strictly not allowed in username", "exclamation-circle", "text-red-400");
        }
        const cleanNew = normalizeUsername(newVal);
        if (RESERVED_USERNAMES.includes(cleanNew)) {
            return window.showToast("Username is reserved", "exclamation-circle", "text-red-400");
        }
        let taken = false;
        for (let uid in allUsersCache) {
            if (uid !== window.currentUser.uid && normalizeUsername(allUsersCache[uid].username) === cleanNew) {
                taken = true; break;
            }
        }
        if (taken) {
            return window.showToast("Username already taken", "exclamation-circle", "text-red-400");
        }
    }

    window.currentUser[field] = newVal;
    await update(ref(db, `${dbUsersPath}/${window.currentUser.uid}`), { [field]: newVal });
    localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));
    populateUserData();
    window.showToast(`${field} updated`);
    window.closeModal(btn);
};

window.openAppearanceModal = () => {
    const config = JSON.parse(localStorage.getItem('chatrix_appearance') || '{}');
    const isDark = config.darkMode === true;

    const html = `
        <h3 class="text-lg font-bold mb-4 text-gray-900">Appearance & Theme</h3>
        <div class="space-y-4 max-h-[60vh] overflow-y-auto pb-4">
            <div class="flex items-center justify-between p-3.5 bg-gray-50 rounded-2xl border border-gray-100">
                <div>
                    <p class="font-bold text-xs text-gray-900">Dark Mode</p>
                    <p class="text-[10px] text-gray-400">Toggle dark / light appearance</p>
                </div>
                <label class="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" id="modal-dark-mode" ${isDark ? 'checked' : ''} class="sr-only peer">
                    <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
            </div>
            <div><label class="block text-xs font-semibold text-gray-700 mb-1">Theme Accent Color</label><input type="color" id="modal-tab-color" value="${config.tabColor || '#3b82f6'}" class="w-full h-10 rounded-xl cursor-pointer border border-gray-200"></div>
            <div><label class="block text-xs font-semibold text-gray-700 mb-1">Message Sent Color</label><input type="color" id="modal-msg-color" value="${config.msgColor || '#3b82f6'}" class="w-full h-10 rounded-xl cursor-pointer border border-gray-200"></div>
        </div>
        <div class="flex gap-2 pt-2 border-t border-gray-100">
            <button class="flex-1 py-3 bg-gray-100 text-gray-700 font-bold rounded-xl text-xs btn-press" onclick="window.resetAppearanceSettings(this)">Reset</button>
            <button class="flex-1 py-3 bg-blue-600 text-white font-bold rounded-xl text-xs btn-press" onclick="window.saveAppearanceSettings(this)">Save</button>
        </div>
    `;
    renderModalHTML(html);
};

window.saveAppearanceSettings = (btn) => {
    const modal = btn.closest('.bg-white');
    const darkMode = modal.querySelector('#modal-dark-mode').checked;
    const tabColor = modal.querySelector('#modal-tab-color').value;
    const msgColor = modal.querySelector('#modal-msg-color').value;

    const config = { darkMode, tabColor, msgColor };
    localStorage.setItem('chatrix_appearance', JSON.stringify(config));
    applyStoredAppearance();
    window.showToast('Appearance updated!');
    window.closeModal(btn);
};

window.resetAppearanceSettings = (btn) => {
    localStorage.removeItem('chatrix_appearance');
    applyStoredAppearance();
    window.showToast('Reset to default');
    window.closeModal(btn);
};

window.openFolderManagerModal = () => {
    let listHtml = '';
    Object.keys(userFolders).forEach(f => {
        listHtml += `
            <div class="flex justify-between items-center p-3 bg-gray-50 rounded-xl mb-1.5 border border-gray-100">
                <span class="font-bold text-xs">${f}</span>
                <button class="text-red-500 text-xs btn-press" onclick="window.deleteFolder('${f}', this)"><i class="fas fa-trash"></i></button>
            </div>
        `;
    });
    const html = `
        <h3 class="text-base font-bold mb-3">Chat Folders</h3>
        <div class="mb-3">
            <input type="text" id="new-folder-inp" placeholder="Folder Name..." class="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl outline-none text-xs font-semibold mb-2">
            <button class="w-full py-2.5 bg-blue-600 text-white font-bold rounded-xl text-xs btn-press" onclick="window.addNewFolder(this)">+ Create Folder</button>
        </div>
        <div class="max-h-36 overflow-y-auto no-scrollbar">${listHtml || '<p class="text-xs text-gray-400 text-center py-2">No custom folders created</p>'}</div>
        <button class="w-full mt-3 py-2.5 bg-gray-100 rounded-xl font-bold text-xs btn-press" onclick="window.closeModal(this)">Close</button>
    `;
    renderModalHTML(html);
};

window.addNewFolder = (btn) => {
    const name = btn.closest('.bg-white').querySelector('#new-folder-inp').value.trim();
    if (!name) return;
    userFolders[name] = true;
    localStorage.setItem('chatrix_folders', JSON.stringify(userFolders));
    renderFolderTabs();
    window.showToast(`Folder "${name}" created`);
    window.closeModal(btn);
};

window.deleteFolder = (name, btn) => {
    delete userFolders[name];
    localStorage.setItem('chatrix_folders', JSON.stringify(userFolders));
    renderFolderTabs();
    window.showToast(`Folder deleted`);
    window.closeModal(btn);
};

function renderFolderTabs() {
    const container = document.getElementById('folder-tabs-container');
    if (!container) return;
    let html = `<button class="folder-tab ${currentFolderFilter === 'All' ? 'active' : ''} text-xs text-gray-500 py-1" onclick="window.selectFolder('All', this)">All Chats</button>`;
    Object.keys(userFolders).forEach(f => { html += `<button class="folder-tab ${currentFolderFilter === f ? 'active' : ''} text-xs text-gray-500 py-1" onclick="window.selectFolder('${f}', this)">${f}</button>`; });
    container.innerHTML = html;
}

window.selectFolder = (name, btn) => {
    currentFolderFilter = name;
    document.querySelectorAll('.folder-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderChatList();
};

window.openArchivedChatsModal = () => {
    const archivedChats = activeChatsList.filter(c => archivedChatIds.includes(c.id));
    let listHtml = '';
    archivedChats.forEach(c => {
        listHtml += `
            <div class="flex items-center justify-between p-3 bg-gray-50 rounded-2xl border border-gray-100 mb-2">
                <div class="flex items-center gap-2.5 min-w-0">
                    <img src="${c.dp}" class="w-10 h-10 rounded-full object-cover">
                    <div class="min-w-0">
                        <h4 class="font-bold text-xs truncate">${c.name}</h4>
                        <p class="text-[10px] text-gray-400 truncate">${c.lastMessage}</p>
                    </div>
                </div>
                <button onclick="window.unarchiveChat('${c.id}', this)" class="px-2.5 py-1 bg-blue-100 text-blue-600 text-[10px] font-bold rounded-lg btn-press">Unarchive</button>
            </div>
        `;
    });
    const html = `
        <h3 class="text-base font-bold mb-3 flex items-center gap-2"><i class="fas fa-archive text-emerald-500"></i> Archived Chats</h3>
        <div class="max-h-60 overflow-y-auto no-scrollbar">${listHtml || '<p class="text-xs text-gray-400 text-center py-6">No archived conversations</p>'}</div>
        <button class="w-full mt-3 py-2.5 bg-gray-100 rounded-xl font-bold text-xs btn-press" onclick="window.closeModal(this)">Close</button>
    `;
    renderModalHTML(html);
};

window.unarchiveChat = (chatId, btn) => {
    archivedChatIds = archivedChatIds.filter(id => id !== chatId);
    localStorage.setItem('chatrix_archived', JSON.stringify(archivedChatIds));
    window.showToast('Chat unarchived');
    renderChatList();
    window.closeModal(btn);
};

function enterSelectionMode(chatId) {
    isSelectionMode = true; selectedChatIds.clear();
    if (chatId) selectedChatIds.add(chatId);
    document.getElementById('normal-header')?.classList.add('hidden');
    document.getElementById('selection-toolbar')?.classList.remove('hidden');
    updateSelectionToolbar(); renderChatList();
}

window.exitSelectionMode = () => {
    isSelectionMode = false; selectedChatIds.clear();
    document.getElementById('normal-header')?.classList.remove('hidden');
    document.getElementById('selection-toolbar')?.classList.add('hidden');
    renderChatList();
};

function toggleChatSelection(chatId) {
    if (selectedChatIds.has(chatId)) selectedChatIds.delete(chatId);
    else selectedChatIds.add(chatId);
    if (selectedChatIds.size === 0) window.exitSelectionMode();
    else { updateSelectionToolbar(); renderChatList(); }
}

function updateSelectionToolbar() {
    const sCount = document.getElementById('selection-count');
    if (sCount) sCount.textContent = `${selectedChatIds.size} Selected`;
    const actions = document.getElementById('selection-actions');
    if (!actions) return;
    actions.innerHTML = `
        ${selectedChatIds.size >= 2 ? `<button onclick="window.openGroupCreateModal()" class="px-2.5 py-1 bg-blue-600 text-white rounded-lg text-xs font-bold shadow btn-press"><i class="fas fa-users mr-1"></i> Group</button>` : ''}
        <button onclick="window.archiveSelectedChats()" class="text-emerald-500 p-1.5" title="Archive"><i class="fas fa-archive"></i></button>
        <button onclick="window.pinSelectedChats()" class="text-blue-500 p-1.5" title="Pin"><i class="fas fa-thumbtack"></i></button>
        <button onclick="window.deleteSelectedChats()" class="text-red-500 p-1.5" title="Delete"><i class="fas fa-trash-alt"></i></button>
    `;
}

window.archiveSelectedChats = () => {
    selectedChatIds.forEach(id => { if (!archivedChatIds.includes(id)) archivedChatIds.push(id); });
    localStorage.setItem('chatrix_archived', JSON.stringify(archivedChatIds));
    window.showToast('Archived selected chats'); window.exitSelectionMode();
};

window.pinSelectedChats = async () => {
    for (let id of selectedChatIds) {
        const c = activeChatsList.find(x => x.id === id);
        if (c) await update(ref(db, `${dbUserChatsPath}/${window.currentUser.uid}/${id}`), { pinned: !c.pinned });
    }
    window.showToast('Updated pin status'); window.exitSelectionMode();
};

window.deleteSelectedChats = () => {
    window.appConfirm("Delete selected conversations?", async () => {
        for (let id of selectedChatIds) await remove(ref(db, `${dbUserChatsPath}/${window.currentUser.uid}/${id}`));
        window.showToast('Chats deleted'); window.exitSelectionMode();
    });
};

window.openGroupCreateModal = () => {
    const html = `
        <div class="space-y-3">
            <h3 class="text-base font-bold">Create Group</h3>
            <input type="text" id="new-grp-title" placeholder="Group Name..." class="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl text-xs font-bold outline-none">
            <div class="flex gap-2">
                <button onclick="window.closeModal(this)" class="flex-1 py-2.5 bg-gray-100 rounded-xl font-bold text-xs btn-press">Cancel</button>
                <button onclick="window.confirmCreateGroup(this)" class="flex-1 py-2.5 bg-blue-600 text-white rounded-xl font-bold text-xs btn-press shadow">Create</button>
            </div>
        </div>
    `;
    renderModalHTML(html);
};

window.confirmCreateGroup = async (btn) => {
    const name = btn.closest('.bg-white').querySelector('#new-grp-title').value.trim();
    if (!name) return window.showToast('Group name required', 'exclamation-circle', 'text-red-400');

    const groupId = 'group_' + Date.now();
    const membersList = [window.currentUser.uid];

    selectedChatIds.forEach(cId => {
        const c = activeChatsList.find(x => x.id === cId);
        if (c && c.targetUid && !membersList.includes(c.targetUid)) membersList.push(c.targetUid);
    });

    const now = Date.now();
    const groupPayload = {
        name, photo: `https://placehold.co/150/2563EB/ffffff?text=${encodeURIComponent(name.charAt(0))}`,
        bio: 'Welcome to our group!', ownerUid: window.currentUser.uid,
        admins: { [window.currentUser.uid]: true }, members: membersList.reduce((acc, uid) => ({ ...acc, [uid]: true }), {}),
        permissions: { canMemberSendMessages: true, canMemberChangeDetails: false }, createdAt: now
    };

    await set(ref(db, `${dbGroupsPath}/${groupId}`), groupPayload);

    for (let uid of membersList) {
        await update(ref(db, `${dbUserChatsPath}/${uid}/${groupId}`), {
            id: groupId, name, dp: groupPayload.photo, isGroup: true,
            lastMessage: encryptData(`${window.currentUser.name} created the group`), timestamp: now, unread: uid !== window.currentUser.uid
        });
    }

    window.exitSelectionMode(); window.closeModal(btn); window.showToast('Group created!');
};

window.openGroupDetailsModal = async function(groupId) {
    if (!groupId) groupId = window.activeChatId;
    const snap = await get(child(ref(db), `${dbGroupsPath}/${groupId}`));
    if (!snap.exists()) return window.showToast("Group details not found", "exclamation-circle", "text-red-400");

    const grp = snap.val();
    const myUid = window.currentUser.uid;
    const isOwner = grp.ownerUid === myUid;
    const isAdmin = Boolean(grp.admins && grp.admins[myUid]);

    let memberRows = '';
    const membersMap = grp.members || {};
    const adminsMap = grp.admins || {};

    for (let memberUid of Object.keys(membersMap)) {
        let u = allUsersCache[memberUid];
        if (!u) { const uSnap = await get(child(ref(db), `${dbUsersPath}/${memberUid}`)); if (uSnap.exists()) u = uSnap.val(); }
        if (!u) u = { name: memberUid, username: memberUid, dp: 'https://placehold.co/100' };

        const isThisOwner = grp.ownerUid === memberUid;
        const isThisAdmin = Boolean(adminsMap[memberUid]);

        let canRemoveThisMember = false, canPromoteDemote = false;
        if (isOwner && !isThisOwner) { canRemoveThisMember = true; canPromoteDemote = true; }
        else if (isAdmin && !isThisOwner && !isThisAdmin) { canRemoveThisMember = true; }

        memberRows += `
            <div class="flex items-center justify-between p-2.5 bg-gray-50 rounded-xl mb-1.5 border border-gray-100">
                <div class="flex items-center gap-2.5 min-w-0 cursor-pointer" onclick="window.closeModal(); window.openUserProfileDirect('${memberUid}')">
                    <img src="${u.dp || 'https://placehold.co/100'}" class="w-9 h-9 rounded-full object-cover">
                    <div class="min-w-0">
                        <p class="font-bold text-xs truncate text-gray-900">${u.name} ${isThisOwner ? '<span class="text-[9px] bg-amber-100 text-amber-700 px-1 py-0.5 rounded font-black ml-1">OWNER</span>' : (isThisAdmin ? '<span class="text-[9px] bg-blue-100 text-blue-700 px-1 py-0.5 rounded font-black ml-1">ADMIN</span>' : '')}</p>
                        <p class="text-[10px] text-gray-400">@${u.username || 'user'}</p>
                    </div>
                </div>
                <div class="flex gap-1">
                    ${canPromoteDemote ? `<button onclick="window.toggleAdminRole('${groupId}', '${memberUid}', ${!isThisAdmin})" class="text-[10px] px-2 py-1 bg-gray-100 rounded-lg font-bold">${isThisAdmin ? 'Demote' : 'Promote'}</button>` : ''}
                    ${canRemoveThisMember ? `<button onclick="window.removeMemberFromGroup('${groupId}', '${memberUid}')" class="text-[10px] px-2 py-1 bg-red-50 text-red-500 rounded-lg font-bold">Remove</button>` : ''}
                </div>
            </div>
        `;
    }

    const html = `
        <div class="space-y-3 max-h-[75vh] overflow-y-auto no-scrollbar">
            <div class="flex items-center justify-between px-1">
                <h3 class="text-base font-black text-gray-900">Group Info</h3>
                ${(isOwner || isAdmin) ? `<button onclick="window.openEditGroupDetailsModal('${groupId}')" class="text-amber-500 hover:text-amber-600 text-sm p-1" title="Edit Group Details"><i class="fas fa-pen"></i></button>` : ''}
            </div>
            <div class="flex flex-col items-center">
                <img src="${grp.photo}" class="w-16 h-16 rounded-full object-cover border-2 border-white shadow mb-1.5">
                <h3 class="text-lg font-black text-gray-900">${grp.name}</h3>
                <p class="text-[11px] text-gray-400 font-medium">${Object.keys(membersMap).length} Members</p>
                ${grp.bio ? `<p class="text-xs text-gray-500 italic text-center mt-1 px-4">${grp.bio}</p>` : ''}
            </div>
            ${(isOwner || isAdmin) ? `
                <div class="p-3 bg-gray-50 rounded-2xl space-y-2 text-xs">
                    <p class="font-bold text-gray-800">Permissions</p>
                    <label class="flex items-center justify-between">
                        <span>Members can send messages</span>
                        <input type="checkbox" ${grp.permissions?.canMemberSendMessages !== false ? 'checked' : ''} onchange="window.updateGroupPerm('${groupId}', 'canMemberSendMessages', this.checked)" ${!isOwner ? 'disabled' : ''}>
                    </label>
                </div>
            ` : ''}
            <div><p class="text-xs font-bold text-gray-500 uppercase mb-1.5">Members List</p>${memberRows}</div>
            ${!isOwner ? `<button onclick="window.leaveGroup('${groupId}')" class="w-full py-2.5 bg-red-50 text-red-500 font-bold text-xs rounded-xl btn-press">Leave Group</button>` : ''}
            <button onclick="window.closeModal(this)" class="w-full py-2.5 bg-gray-100 font-bold text-xs rounded-xl btn-press">Close</button>
        </div>
    `;
    renderModalHTML(html);
};

window.openEditGroupDetailsModal = async (groupId) => {
    const snap = await get(child(ref(db), `${dbGroupsPath}/${groupId}`));
    if (!snap.exists()) return;
    const grp = snap.val();
    const html = `
        <div class="space-y-3">
            <h3 class="text-base font-bold text-gray-900">Edit Group Details</h3>
            <div><label class="text-[10px] font-bold text-gray-400 uppercase">Group Name</label><input type="text" id="edit-grp-name" value="${grp.name || ''}" class="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-xl text-xs font-bold outline-none mt-1"></div>
            <div><label class="text-[10px] font-bold text-gray-400 uppercase">Description / Bio</label><textarea id="edit-grp-bio" rows="2" class="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-xl text-xs font-medium outline-none mt-1">${grp.bio || ''}</textarea></div>
            <div><label class="text-[10px] font-bold text-gray-400 uppercase">Photo URL</label><input type="text" id="edit-grp-photo" value="${grp.photo || ''}" class="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-xl text-xs outline-none mt-1"></div>
            <div class="flex gap-2 pt-2">
                <button onclick="window.closeModal(this)" class="flex-1 py-2.5 bg-gray-100 rounded-xl font-bold text-xs btn-press">Cancel</button>
                <button onclick="window.saveGroupDetails('${groupId}', this)" class="flex-1 py-2.5 bg-blue-600 text-white rounded-xl font-bold text-xs btn-press shadow">Save</button>
            </div>
        </div>
    `;
    renderModalHTML(html);
};

window.saveGroupDetails = async (groupId, btn) => {
    const modal = btn.closest('.bg-white');
    const name = modal.querySelector('#edit-grp-name').value.trim(), bio = modal.querySelector('#edit-grp-bio').value.trim(), photo = modal.querySelector('#edit-grp-photo').value.trim();
    if (!name) return window.showToast('Group name required', 'exclamation-circle', 'text-red-400');
    await update(ref(db, `${dbGroupsPath}/${groupId}`), { name, bio, photo });
    await update(ref(db, `${dbUserChatsPath}/${window.currentUser.uid}/${groupId}`), { name, dp: photo });
    window.showToast("Group details updated"); window.closeModal(btn); window.openGroupDetailsModal(groupId);
};

window.updateGroupPerm = async (groupId, permKey, value) => { await update(ref(db, `${dbGroupsPath}/${groupId}/permissions`), { [permKey]: value }); window.showToast("Permission updated"); };
window.toggleAdminRole = async (groupId, memberUid, makeAdmin) => { await update(ref(db, `${dbGroupsPath}/${groupId}/admins`), { [memberUid]: makeAdmin ? true : null }); window.showToast(makeAdmin ? "Promoted to Admin" : "Demoted"); window.openGroupDetailsModal(groupId); };
window.removeMemberFromGroup = async (groupId, memberUid) => { await remove(ref(db, `${dbGroupsPath}/${groupId}/members/${memberUid}`)); await remove(ref(db, `${dbGroupsPath}/${groupId}/admins/${memberUid}`)); await remove(ref(db, `${dbUserChatsPath}/${memberUid}/${groupId}`)); window.showToast("Member removed"); window.openGroupDetailsModal(groupId); };
window.leaveGroup = async (groupId) => { await remove(ref(db, `${dbGroupsPath}/${groupId}/members/${window.currentUser.uid}`)); await remove(ref(db, `${dbUserChatsPath}/${window.currentUser.uid}/${groupId}`)); window.showToast("Left group"); document.querySelectorAll('.modal-enter-active').forEach(m => m.remove()); document.getElementById('back-from-chat')?.click(); };

window.openForwardModal = (msgId) => {
    let recipientsList = '';
    activeChatsList.forEach(c => {
        recipientsList += `
            <label class="flex items-center justify-between p-3 bg-gray-50 rounded-2xl cursor-pointer hover:bg-blue-50/50 transition-all border border-gray-100">
                <div class="flex items-center gap-3 min-w-0">
                    <img src="${c.dp}" class="w-10 h-10 rounded-full object-cover">
                    <div class="min-w-0">
                        <h4 class="font-bold text-xs text-gray-900 truncate">${c.name}</h4>
                        <p class="text-[10px] text-gray-400 truncate">@${c.username || 'user'}</p>
                    </div>
                </div>
                <input type="checkbox" value="${c.id}" class="fwd-cb w-4 h-4 text-blue-600 rounded">
            </label>
        `;
    });
    const html = `
        <div class="space-y-3">
            <div class="flex items-center justify-between pb-2 border-b border-gray-100">
                <h3 class="text-base font-bold text-gray-900">Forward Message</h3>
                <button onclick="window.closeModal(this)" class="text-gray-400 hover:text-gray-600 text-sm"><i class="fas fa-times"></i></button>
            </div>
            <div class="max-h-[60vh] overflow-y-auto no-scrollbar space-y-2">${recipientsList || '<p class="text-xs text-gray-400 text-center py-6">No conversations</p>'}</div>
            <div class="flex gap-2 pt-2 border-t border-gray-100">
                <button onclick="window.closeModal(this)" class="flex-1 py-3 bg-gray-100 rounded-xl font-bold text-xs btn-press">Cancel</button>
                <button onclick="window.confirmForward('${msgId}', this)" class="flex-1 py-3 bg-blue-600 text-white rounded-xl font-bold text-xs btn-press shadow-md">Send Forward</button>
            </div>
        </div>
    `;
    renderModalHTML(html);
};

window.confirmForward = async (msgId, btn) => {
    const selected = Array.from(btn.closest('.bg-white').querySelectorAll('.fwd-cb:checked')).map(cb => cb.value);
    if (selected.length === 0) return window.showToast('Select at least one recipient', 'exclamation-circle', 'text-red-400');

    const msgSnap = await get(child(ref(db), `${dbChatsPath}/${window.activeChatId}/messages/${msgId}`));
    if (!msgSnap.exists()) return window.showToast('Message not found', 'exclamation-circle', 'text-red-400');

    const m = msgSnap.val(), now = Date.now(), timeStr = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), forwardSenderName = window.activeChatUser?.isSelf ? 'Saved Messages' : (window.activeChatUser?.name || 'Chatrix User');

    for (let targetChatId of selected) {
        const msgPayload = { senderId: window.currentUser.uid, type: m.type || 'text', text: m.text || null, imageUrl: m.imageUrl || null, audioUrl: m.audioUrl || null, stickerUrl: m.stickerUrl || null, timestamp: now, time: timeStr, forwardedFrom: { name: forwardSenderName } };
        await push(ref(db, `${dbChatsPath}/${targetChatId}/messages`), msgPayload);
        
        const rawPreview = m.type === 'sticker' ? 'Sticker' : (decryptData(m.text) || (m.imageUrl ? 'Photo' : 'Voice note'));
        
        await update(ref(db, `${dbUserChatsPath}/${window.currentUser.uid}/${targetChatId}`), { lastMessage: encryptData(`Forwarded: ${rawPreview}`), timestamp: now, unread: false });
        
        const targetChat = activeChatsList.find(x => x.id === targetChatId);
        if (targetChat && !targetChat.isGroup && targetChat.targetUid && targetChat.targetUid !== OFFICIAL_SYSTEM_UID && targetChat.targetUid !== window.currentUser.uid) {
            // TICK FIX: Set isPremium explicitly
            await update(ref(db, `${dbUserChatsPath}/${targetChat.targetUid}/${targetChatId}`), { id: targetChatId, targetUid: window.currentUser.uid, name: window.currentUser.name, username: window.currentUser.username, dp: window.currentUser.dp, isPremium: Boolean(window.currentUser.isPremium === true), lastMessage: encryptData(`Forwarded: ${rawPreview}`), timestamp: now, unread: true });
        }
    }
    window.showToast('Message forwarded successfully!'); window.closeModal(btn);
};

function showMessageActionModal(msg, isMe) {
    let html = `
        <div class="space-y-1">
            <button class="w-full flex items-center p-3 rounded-2xl hover:bg-gray-50 text-xs font-semibold btn-press text-left" onclick="window.initiateReply('${msg.id}'); window.closeModal(this)"><i class="fas fa-reply w-6 text-blue-500"></i> Reply</button>
            <button class="w-full flex items-center p-3 rounded-2xl hover:bg-gray-50 text-xs font-semibold btn-press text-left" onclick="window.closeModal(this); window.openForwardModal('${msg.id}')"><i class="fas fa-share w-6 text-indigo-500"></i> Forward</button>
    `;
    if (msg.type === 'text') {
        const rawText = decryptData(msg.text || '').replace(/'/g, "\\'");
        html += `<button class="w-full flex items-center p-3 rounded-2xl hover:bg-gray-50 text-xs font-semibold btn-press text-left" onclick="window.copyToClipboard('${rawText}'); window.closeModal(this)"><i class="fas fa-copy w-6 text-emerald-500"></i> Copy Text</button>`;
        if (isMe) html += `<button class="w-full flex items-center p-3 rounded-2xl hover:bg-gray-50 text-xs font-semibold btn-press text-left text-green-600" onclick="window.closeModal(this); window.promptEditMessage('${msg.id}', '${rawText}');"><i class="fas fa-edit w-6 text-green-500"></i> Edit Message</button>`;
    }
    if (msg.type === 'image' && msg.imageUrl) { html += `<button class="w-full flex items-center p-3 rounded-2xl hover:bg-gray-50 text-xs font-semibold btn-press text-left text-blue-600" onclick="window.downloadChatImage('${msg.imageUrl}'); window.closeModal(this)"><i class="fas fa-download w-6 text-blue-500"></i> Download Image</button>`; }
    if (isMe) { html += `<button class="w-full flex items-center p-3 rounded-2xl hover:bg-red-50 text-red-500 text-xs font-semibold btn-press text-left" onclick="window.deleteMessage('${msg.id}'); window.closeModal(this)"><i class="fas fa-trash-alt w-6"></i> Delete Message</button>`; }
    html += `</div>`; renderModalHTML(html);
}

window.promptEditMessage = (msgId, currentText) => {
    const html = `
        <h3 class="text-base font-bold mb-2">Edit Message</h3>
        <textarea id="edit-msg-input" rows="3" class="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl text-xs font-medium outline-none mb-3">${currentText}</textarea>
        <div class="flex gap-2">
            <button onclick="window.closeModal(this)" class="flex-1 py-2.5 bg-gray-100 rounded-xl font-bold text-xs btn-press">Cancel</button>
            <button onclick="window.saveEditedMessage('${msgId}', this)" class="flex-1 py-2.5 bg-blue-600 text-white rounded-xl font-bold text-xs btn-press">Save</button>
        </div>
    `;
    renderModalHTML(html);
};

window.saveEditedMessage = async (msgId, btn) => {
    const newText = btn.closest('.bg-white').querySelector('#edit-msg-input').value.trim();
    if (!newText) return;
    await update(ref(db, `${dbChatsPath}/${window.activeChatId}/messages/${msgId}`), { text: encryptData(newText), edited: true });
    window.showToast("Message edited"); window.closeModal(btn);
};

window.downloadChatImage = (url) => { const a = document.createElement('a'); a.href = url; a.download = `chatrix_img_${Date.now()}.jpg`; document.body.appendChild(a); a.click(); document.body.removeChild(a); window.showToast("Image downloading..."); };

window.initiateReply = (msgId) => {
    const textSnippet = (document.getElementById(`msg-${msgId}`)?.innerText || 'Message').slice(0, 35);
    currentReplyTarget = { id: msgId, senderName: window.activeChatUser?.isSelf ? 'Saved Messages' : (window.activeChatUser?.name || 'User'), textSnippet };
    document.getElementById('reply-to-user').textContent = `Replying to ${currentReplyTarget.senderName}`;
    document.getElementById('reply-to-text').textContent = currentReplyTarget.textSnippet;
    document.getElementById('reply-preview-bar').classList.remove('hidden');
    document.getElementById('message-input').focus();
};

window.cancelReply = () => { currentReplyTarget = null; document.getElementById('reply-preview-bar')?.classList.add('hidden'); };

window.deleteMessage = (id) => {
    window.appConfirm("Delete this message?", async () => {
        await remove(ref(db, `${dbChatsPath}/${window.activeChatId}/messages/${id}`));
        window.showToast('Message deleted');
    });
};

window.openChangePasswordModal = () => {
    const html = `
        <div class="space-y-3">
            <h3 class="text-base font-bold text-gray-900">Change Password</h3>
            <div><label class="text-[10px] font-bold text-gray-400 uppercase">Current Password</label><input type="password" id="current-pass-inp" class="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-xl text-xs outline-none mt-1"></div>
            <div><label class="text-[10px] font-bold text-gray-400 uppercase">New Password</label><input type="password" id="new-pass-inp" class="w-full p-2.5 bg-gray-50 border border-gray-200 rounded-xl text-xs outline-none mt-1"></div>
            <div class="flex gap-2 pt-2">
                <button onclick="window.closeModal(this)" class="flex-1 py-2.5 bg-gray-100 rounded-xl font-bold text-xs btn-press">Cancel</button>
                <button onclick="window.saveNewPassword(this)" class="flex-1 py-2.5 bg-blue-600 text-white rounded-xl font-bold text-xs btn-press shadow">Update</button>
            </div>
        </div>
    `;
    renderModalHTML(html);
};

window.saveNewPassword = async (btn) => {
    const modal = btn.closest('.bg-white'), cur = modal.querySelector('#current-pass-inp').value, next = modal.querySelector('#new-pass-inp').value;
    if (!cur || !next) return window.showToast("All fields required", "exclamation-circle", "text-red-400");
    if (decryptData(window.currentUser.password) !== cur) return window.showToast("Current password incorrect", "exclamation-circle", "text-red-400");
    const encPass = encryptData(next);
    await update(ref(db, `${dbUsersPath}/${window.currentUser.uid}`), { password: encPass });
    window.currentUser.password = encPass; localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));
    window.showToast("Password updated!"); window.closeModal(btn);
};

function getDeviceLabel() {
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    let os = 'Unknown Device';
    if (/Android/i.test(navigator.userAgent)) os = 'Android Device';
    else if (/iPhone|iPad/i.test(navigator.userAgent)) os = 'Apple iOS Device';
    else if (/Windows/i.test(navigator.userAgent)) os = 'Windows PC';
    else if (/Mac/i.test(navigator.userAgent)) os = 'MacBook';
    return { label: os, isMobile: isMobile, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata' };
}

async function registerDeviceSession() {
    if (!window.currentUser?.uid) return;
    let sId = localStorage.getItem('chatrix_session_id');
    if (!sId) { sId = 'session_' + Date.now(); localStorage.setItem('chatrix_session_id', sId); }
    const dev = getDeviceLabel();
    await set(ref(db, `${dbUsersPath}/${window.currentUser.uid}/sessions/${sId}`), { id: sId, deviceName: dev.label, isMobile: dev.isMobile, location: dev.tz, lastActive: Date.now() });
    
    let isInitialLoad = true;
    onValue(ref(db, `${dbUsersPath}/${window.currentUser.uid}/sessions/${sId}`), (snap) => {
        if (!isInitialLoad && !snap.exists() && window.currentUser) { 
            window.showToast("Session terminated from another device", "exclamation-circle", "text-red-400"); 
            setTimeout(() => window.handleLogout(), 1200); 
        }
        isInitialLoad = false;
    });
}

window.openActiveDevicesModal = async () => {
    const snap = await get(child(ref(db), `${dbUsersPath}/${window.currentUser.uid}/sessions`));
    const sessions = snap.exists() ? snap.val() : {};
    let listHtml = '';
    for (let sId of Object.keys(sessions)) {
        const s = sessions[sId];
        const isThisCurrent = sId === localStorage.getItem('chatrix_session_id');
        listHtml += `
            <div class="flex items-center justify-between p-3 bg-gray-50 rounded-2xl border border-gray-100 mb-2">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center text-lg"><i class="fas ${s.isMobile ? 'fa-mobile-alt' : 'fa-laptop'}"></i></div>
                    <div>
                        <h4 class="font-bold text-xs text-gray-900">${s.deviceName} ${isThisCurrent ? '<span class="text-[9px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-black ml-1">THIS DEVICE</span>' : ''}</h4>
                        <p class="text-[10px] text-gray-400">${s.location} • ${new Date(s.lastActive).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                    </div>
                </div>
                ${!isThisCurrent ? `<button onclick="window.terminateSession('${sId}', this)" class="px-2.5 py-1 bg-red-50 text-red-600 text-[10px] font-bold rounded-lg btn-press">Terminate</button>` : ''}
            </div>
        `;
    }
    const html = `
        <div class="space-y-3">
            <h3 class="text-base font-bold text-gray-900">Active Devices & Sessions</h3>
            <p class="text-xs text-gray-400">Manage all devices logged into your account</p>
            <div class="max-h-60 overflow-y-auto no-scrollbar">${listHtml || '<p class="text-xs text-gray-400 text-center py-4">No active devices found</p>'}</div>
            <button onclick="window.closeModal(this)" class="w-full py-2.5 bg-gray-100 font-bold text-xs rounded-xl btn-press">Close</button>
        </div>
    `;
    renderModalHTML(html);
};

window.terminateSession = async (sId, btn) => { 
    await remove(ref(db, `${dbUsersPath}/${window.currentUser.uid}/sessions/${sId}`)); 
    window.showToast("Device session terminated"); 
    window.openActiveDevicesModal(); 
};

// -------------------------------------------------------------
// PROFILE MEDIA / LINKS LOADERS
// -------------------------------------------------------------
async function populateContactMediaAndLinks() {
    const mediaGrid = document.getElementById('overlay-profile-media-grid');
    const linksList = document.getElementById('overlay-profile-links-list');
    
    if(!mediaGrid || !linksList) return;

    mediaGrid.innerHTML = '';
    linksList.innerHTML = '';

    if (!window.activeChatId) {
        mediaGrid.innerHTML = '<div class="col-span-3 text-center py-6 text-gray-400 text-xs">No media available.</div>';
        linksList.innerHTML = '<div class="text-center py-6 text-gray-400 text-xs">No links available.</div>';
        return;
    }

    const snap = await get(ref(db, `${dbChatsPath}/${window.activeChatId}/messages`));
    if (!snap.exists()) {
        mediaGrid.innerHTML = '<div class="col-span-3 text-center py-6 text-gray-400 text-xs">No media available.</div>';
        linksList.innerHTML = '<div class="text-center py-6 text-gray-400 text-xs">No links available.</div>';
        return;
    }

    const msgs = snap.val();
    let mediaCount = 0;
    let linkCount = 0;
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;

    Object.values(msgs).forEach(m => {
        if (m.type === 'image' && m.imageUrl) {
            mediaGrid.innerHTML += `<div class="rounded-lg overflow-hidden bg-black aspect-square cursor-pointer border border-gray-100 dark:border-white/5" onclick="window.previewImage('${m.imageUrl}')"><img src="${m.imageUrl}" class="w-full h-full object-cover"></div>`;
            mediaCount++;
        }
        if (m.type === 'text' && m.text) {
            const rawText = decryptData(m.text);
            const links = rawText.match(urlRegex);
            if (links) {
                links.forEach(link => {
                    linksList.innerHTML += `
                        <div class="p-2.5 bg-gray-50 dark:bg-slate-800 rounded-xl flex items-center justify-between border border-gray-100 dark:border-white/5 mb-1.5 cursor-pointer" onclick="window.triggerScamWarning('${encodeURIComponent(link)}')">
                            <div class="min-w-0 flex-1 pr-2"><span class="text-xs font-bold text-blue-600 dark:text-blue-400 truncate block">${link}</span></div>
                            <i class="fas fa-external-link-alt text-gray-400 text-xs"></i>
                        </div>
                    `;
                    linkCount++;
                });
            }
        }
    });

    if (mediaCount === 0) mediaGrid.innerHTML = '<div class="col-span-3 text-center py-6 text-gray-400 text-xs">No media available.</div>';
    if (linkCount === 0) linksList.innerHTML = '<div class="text-center py-6 text-gray-400 text-xs">No links available.</div>';
}

window.openStoryEditor = () => { document.getElementById('story-editor-overlay')?.classList.remove('hidden'); };

window.closeStoryEditor = () => {
    document.getElementById('story-editor-overlay')?.classList.add('hidden');
    if (typeof storyCtx !== 'undefined' && storyCtx && storyCanvas) storyCtx.clearRect(0, 0, storyCanvas.width, storyCanvas.height);
    const placeholder = document.getElementById('story-upload-placeholder');
    if (placeholder) { placeholder.classList.remove('hidden'); placeholder.style.display = 'flex'; }
    const textLayer = document.getElementById('story-text-overlay');
    if (textLayer) { textLayer.classList.add('hidden'); textLayer.innerHTML = ''; }
    if (document.getElementById('story-caption-input')) document.getElementById('story-caption-input').value = '';
    if (typeof storyImage !== 'undefined') storyImage = null;
};

window.toggleStoryBrush = () => {
    isBrushActive = !isBrushActive;
    const btn = document.getElementById('brush-toggle-btn');
    if(btn) { btn.classList.toggle('bg-blue-600', isBrushActive); btn.classList.toggle('bg-white/10', !isBrushActive); }
    window.showToast(isBrushActive ? 'Brush tool activated' : 'Brush tool deactivated');
};

window.addStoryTextPrompt = () => {
    const t = prompt("Enter text for story:");
    if(t) { const el = document.getElementById('story-text-overlay'); el.innerHTML = `<span>${t}</span>`; el.classList.remove('hidden'); }
};

window.publishStory = async () => {
    if (!storyCanvas || !storyImage) return window.showToast('Please select a photo first!', 'exclamation-circle', 'text-red-400');
    
    const b64 = storyCanvas.toDataURL('image/jpeg', 0.65);
    const caption = document.getElementById('story-caption-input')?.value || '';
    const textOverlayStr = document.getElementById('story-text-overlay')?.innerText || '';
    const now = Date.now();
    
    await push(ref(db, `${dbStoriesPath}`), {
        ownerUid: window.currentUser.uid, ownerName: window.currentUser.name, ownerDp: window.currentUser.dp,
        photo: b64, caption: caption, storyText: textOverlayStr !== 'Story Text' ? textOverlayStr : '',
        createdAt: now, likes: {}, views: {}
    });
    window.showToast("Story posted successfully!"); window.closeStoryEditor();
};

window.deleteStory = (storyId) => { 
    window.appConfirm("Delete this post?", async () => {
        await remove(ref(db, `${dbStoriesPath}/${storyId}`)); 
        window.showToast("Post deleted"); 
    });
};

// -------------------------------------------------------------
// DOM SETUP & LOGIN / SIGNUP LOGIC
// -------------------------------------------------------------

function setupDomListeners() {
    document.getElementById('go-to-signup').onclick = e => { e.preventDefault(); switchMainView('signup-view'); };
    document.getElementById('go-to-login').onclick = e => { e.preventDefault(); switchMainView('login-view'); };

    const loginBtn = document.querySelector('#login-form button');
    if(loginBtn) {
        loginBtn.type = 'button'; 
        loginBtn.onclick = async () => {
            const btn = loginBtn;
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            const user = normalizeUsername(document.getElementById('login-username').value).replace(/[.#$\[\]]/g, '_');
            const pass = document.getElementById('login-password').value;
            try {
                if (RESERVED_USERNAMES.includes(user)) throw new Error("Reserved username.");
                const snap = await get(child(ref(db), `${dbUsersPath}/${user}`));
                
                if (!snap.exists() || decryptData(snap.val().password) !== pass) throw new Error("Invalid username or password.");
                window.currentUser = snap.val(); localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));

                // Verify ban state upon login
                if (checkAndEnforceBan()) {
                    btn.innerHTML = originalText;
                    return;
                }

                const welcomeId = [OFFICIAL_SYSTEM_UID, user].sort().join('_'), now = Date.now(), timeStr = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                await push(ref(db, `${dbChatsPath}/${welcomeId}/messages`), { senderId: OFFICIAL_SYSTEM_UID, text: encryptData(`Security Alert: New login detected for your Chatrix account at ${timeStr}. Device: ${getDeviceLabel().label}.`), timestamp: now, time: timeStr });
                await update(ref(db, `${dbUserChatsPath}/${user}/${welcomeId}`), { id: welcomeId, targetUid: OFFICIAL_SYSTEM_UID, name: 'Chatrix', username: 'chatrix_official', dp: 'https://placehold.co/150/2563eb/ffffff?text=CX', isVerified: true, isOfficial: true, lastMessage: encryptData(`Security Alert: New login detected at ${timeStr}`), timestamp: now, unread: true });
                
                window.history.replaceState({}, document.title, window.location.pathname);
                proceedToMainApp();
            } catch (err) { 
                const errEl = document.getElementById('login-error'); 
                errEl.textContent = err.message; 
                errEl.classList.remove('hidden'); 
            } finally { 
                btn.innerHTML = originalText; 
            }
        };
    }

    const signupBtn = document.querySelector('#signup-form button');
    if(signupBtn) {
        signupBtn.type = 'button';
        signupBtn.onclick = async () => {
            const btn = signupBtn;
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
            const name = document.getElementById('signup-name').value.trim();
            const rawUser = document.getElementById('signup-username').value.trim();
            
            // STRICT NO SPACE IN USERNAME
            if (/\s/.test(rawUser)) {
                btn.innerHTML = originalText;
                const errEl = document.getElementById('signup-error');
                errEl.textContent = "Spaces are strictly not allowed in usernames.";
                errEl.classList.remove('hidden');
                return;
            }

            const user = normalizeUsername(rawUser).replace(/[.#$\[\]]/g, '_');
            const pass = document.getElementById('signup-password').value;
            
            try {
                if (RESERVED_USERNAMES.includes(user)) throw new Error("Reserved username.");
                if (user.length < 3) throw new Error("Username must be at least 3 characters.");
                
                const usersSnap = await get(ref(db, dbUsersPath));
                if (usersSnap.exists()) {
                    const allU = usersSnap.val();
                    for (let k in allU) {
                        if (normalizeUsername(allU[k].username) === normalizeUsername(rawUser) || k === user) {
                            throw new Error("Username already taken by someone else.");
                        }
                    }
                }

                const encPass = encryptData(pass);
                const dp = document.getElementById('dp-preview').src || `https://placehold.co/150x150/2563EB/ffffff?text=${name.charAt(0).toUpperCase()}`;
                const newUser = { uid: user, name, username: rawUser, password: encPass, dp, bio: 'Trust once lost is never found again.', birthday: '', isPremium: false };
                await set(ref(db, `${dbUsersPath}/${user}`), newUser);

                const welcomeId = [OFFICIAL_SYSTEM_UID, user].sort().join('_'), now = Date.now();
                await push(ref(db, `${dbChatsPath}/${welcomeId}/messages`), { senderId: OFFICIAL_SYSTEM_UID, text: encryptData('Welcome to Chatrix! Connect with @ChatrixSupport for help.'), timestamp: now, time: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
                await update(ref(db, `${dbUserChatsPath}/${user}/${welcomeId}`), { id: welcomeId, targetUid: OFFICIAL_SYSTEM_UID, name: 'Chatrix', username: 'chatrix_official', dp: 'https://placehold.co/150/2563eb/ffffff?text=CX', isVerified: true, isOfficial: true, lastMessage: encryptData('Welcome to Chatrix!'), timestamp: now, unread: true });

                window.currentUser = newUser; localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser));
                window.history.replaceState({}, document.title, window.location.pathname);
                proceedToMainApp();
            } catch (err) { 
                const errEl = document.getElementById('signup-error'); 
                errEl.textContent = err.message; 
                errEl.classList.remove('hidden'); 
            } finally { 
                btn.innerHTML = originalText; 
            }
        };
    }

    // SIGNUP DP LIMIT (5MB)
    document.getElementById('signup-dp').onchange = async (e) => {
        if (e.target.files?.[0]) { 
            const file = e.target.files[0];
            if (file.size > 5 * 1024 * 1024) {
                window.showToast("Profile photo exceeds 5MB limit", "exclamation-circle", "text-red-400");
                e.target.value = '';
                return;
            }
            const b64 = await fileToBase64(file, 240); 
            document.getElementById('dp-preview').src = b64; 
            document.getElementById('dp-preview').classList.remove('hidden'); 
            document.getElementById('dp-icon').classList.add('hidden'); 
        }
    };

    // CHANGE DP LIMIT (5MB)
    document.getElementById('change-dp-input').onchange = async (e) => {
        if (e.target.files?.[0]) { 
            const file = e.target.files[0];
            if (file.size > 5 * 1024 * 1024) {
                window.showToast("Profile photo exceeds 5MB limit", "exclamation-circle", "text-red-400");
                e.target.value = '';
                return;
            }
            const b64 = await fileToBase64(file, 240); 
            window.currentUser.dp = b64; 
            await update(ref(db, `${dbUsersPath}/${window.currentUser.uid}`), { dp: b64 }); 
            localStorage.setItem('chatrix_user', JSON.stringify(window.currentUser)); 
            populateUserData(); 
            window.showToast('Profile photo updated'); 
        }
    };

    const premiumBtnAction = document.getElementById('premium-btn-action');
    if (premiumBtnAction) {
        premiumBtnAction.onclick = () => {
            if (window.currentUser && window.currentUser.isPremium) {
                window.openAdvancedColorPicker();
            } else {
                window.openPremiumModal();
            }
        };
    }

    const msgInput = document.getElementById('message-input'), sendBtn = document.getElementById('send-btn'), micBtn = document.getElementById('mic-btn');
    if(msgInput) {
        msgInput.addEventListener('focus', () => { setTimeout(() => { const container = document.getElementById('messages-container'); if (container) container.scrollTop = container.scrollHeight; }, 300); });
        msgInput.oninput = () => { msgInput.style.height = 'auto'; msgInput.style.height = msgInput.scrollHeight + 'px'; if (msgInput.value.trim()) { sendBtn.classList.remove('hidden'); micBtn.classList.add('hidden'); } else { sendBtn.classList.add('hidden'); micBtn.classList.remove('hidden'); } };
        msgInput.onkeydown = (e) => { if (e.key === 'Enter') { if (enterIsSend && !e.shiftKey) { e.preventDefault(); if (msgInput.value.trim()) sendBtn.click(); } } };
    }
    
    if(sendBtn) {
        sendBtn.onclick = (e) => { e.preventDefault(); const text = msgInput.value.trim(); if (!text) return; dispatchMessage(text); msgInput.value = ''; msgInput.style.height = 'auto'; sendBtn.classList.add('hidden'); micBtn.classList.remove('hidden'); };
    }

    const attachInp = document.getElementById('attachment-input');
    if(attachInp) {
        attachInp.onchange = async (e) => { if (e.target.files?.[0]) { const b64 = await fileToBase64(e.target.files[0], 720); dispatchMessage('', b64); } };
    }

    const storyInput = document.getElementById('story-file-input');
    if (storyInput) {
        storyInput.onchange = (e) => {
            if (e.target.files?.[0]) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    storyImage = new Image();
                    storyImage.onload = () => {
                        storyCanvas = document.getElementById('story-canvas'); storyCtx = storyCanvas.getContext('2d');
                        let cw = 720, ch = Math.round((storyImage.height / storyImage.width) * cw);
                        storyCanvas.width = cw; storyCanvas.height = ch; storyCtx.drawImage(storyImage, 0, 0, cw, ch);
                        const placeholder = document.getElementById('story-upload-placeholder');
                        if (placeholder) { placeholder.classList.add('hidden'); placeholder.style.display = 'none'; }
                    };
                    storyImage.src = event.target.result;
                };
                reader.readAsDataURL(e.target.files[0]);
            }
        };
    }
    
    if (document.getElementById('story-canvas')) {
        const cvs = document.getElementById('story-canvas');
        const draw = (e) => {
            if (!isDrawing || !isBrushActive) return;
            const rect = cvs.getBoundingClientRect(), scaleX = cvs.width / rect.width, scaleY = cvs.height / rect.height;
            const x = (e.clientX || e.touches?.[0]?.clientX - rect.left) * scaleX, y = (e.clientY || e.touches?.[0]?.clientY - rect.top) * scaleY;
            storyCtx.lineWidth = 10; storyCtx.lineCap = 'round'; storyCtx.strokeStyle = document.getElementById('story-brush-color')?.value || '#ef4444';
            storyCtx.lineTo(x, y); storyCtx.stroke(); storyCtx.beginPath(); storyCtx.moveTo(x, y);
        };
        cvs.addEventListener('mousedown', (e) => { isDrawing = true; draw(e); });
        cvs.addEventListener('mousemove', draw);
        cvs.addEventListener('mouseup', () => { isDrawing = false; storyCtx?.beginPath(); });
        cvs.addEventListener('touchstart', (e) => { isDrawing = true; draw(e); }, {passive: true});
        cvs.addEventListener('touchmove', draw, {passive: true});
        cvs.addEventListener('touchend', () => { isDrawing = false; storyCtx?.beginPath(); });
    }

    const searchInput = document.getElementById('global-search-input'), clearSearchBtn = document.getElementById('clear-search-btn');
    if (searchInput) {
        searchInput.oninput = (e) => {
            const q = e.target.value.trim();
            if (q) { clearSearchBtn.classList.remove('hidden'); document.getElementById('search-history-header').classList.add('hidden'); performLiveSearch(q); } 
            else { clearSearchBtn.classList.add('hidden'); document.getElementById('search-history-header').classList.remove('hidden'); renderSearchHistory(); }
        };
    }
    if (clearSearchBtn) { clearSearchBtn.onclick = () => { searchInput.value = ''; clearSearchBtn.classList.add('hidden'); renderSearchHistory(); }; }
}

// -------------------------------------------------------------
// HELPER UTILITIES
// -------------------------------------------------------------

window.handleLogout = () => { localStorage.removeItem('chatrix_user'); window.currentUser = null; switchMainView('login-view'); };

window.confirmDeleteAccount = () => {
    window.appConfirm("Permanently delete your Chatrix account?", async () => {
        await remove(ref(db, `${dbUsersPath}/${window.currentUser.uid}`));
        window.handleLogout(); window.showToast('Account deleted');
    });
};

window.switchTab = (tabId) => {
    ['home', 'stories', 'settings', 'profile'].forEach(t => {
        const el = document.getElementById(`${t}-tab`);
        if (el) { el.classList.toggle('tab-visible', t === tabId); el.classList.toggle('tab-hidden', t !== tabId); }
    });
    document.querySelectorAll('.nav-btn').forEach(btn => {
        const active = btn.dataset.target === tabId;
        btn.classList.toggle('nav-btn-active', active); btn.classList.toggle('text-blue-600', active); btn.classList.toggle('text-gray-400', !active);
    });
    if (tabId === 'stories' && typeof window.renderStoriesFeed === 'function') window.renderStoriesFeed();
    if (tabId === 'profile' && typeof window.renderMyProfilePosts === 'function') window.renderMyProfilePosts();
};

window.showToast = (msg, icon = 'check-circle', color = 'text-green-400') => {
    const t = document.getElementById('toast'); if (!t) return;
    document.getElementById('toast-icon').innerHTML = `<i class="fas fa-${icon} ${color}"></i>`;
    document.getElementById('toast-msg').textContent = msg;
    t.classList.remove('-translate-y-[200%]'); setTimeout(() => t.classList.add('-translate-y-[200%]'), 3000);
};

function renderModalHTML(htmlContent) {
    const container = document.getElementById('modals-container'); if (!container) return;
    const m = document.createElement('div'); m.className = "fixed inset-0 z-[150] flex items-end justify-center sm:items-center modal-enter";
    m.innerHTML = `
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onclick="window.closeModal()"></div>
        <div class="bg-white w-full max-w-sm rounded-t-3xl sm:rounded-3xl p-5 relative z-10 shadow-2xl transition-transform duration-300 transform translate-y-full sm:translate-y-0 text-gray-900">
            <div class="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4 sm:hidden"></div>
            ${htmlContent}
        </div>
    `;
    container.appendChild(m);
    setTimeout(() => { m.classList.add('modal-enter-active'); m.querySelector('.bg-white')?.classList.remove('translate-y-full'); }, 10);
}

window.closeModal = (btn) => {
    if (!btn) { document.querySelectorAll('.modal-enter-active, #modals-container > div').forEach(el => el.remove()); return; }
    const modalWrap = btn.closest('.fixed') || btn.closest('.modal-enter-active');
    if (modalWrap) modalWrap.remove(); else document.querySelectorAll('.modal-enter-active, #modals-container > div').forEach(el => el.remove());
};

window.copyToClipboard = (text) => { navigator.clipboard.writeText(text); window.showToast('Copied to clipboard'); };
window.scrollToMessage = (id) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); };

function fileToBase64(file, maxWidth = 720) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if (w > maxWidth) { h = Math.round((h * maxWidth) / w); w = maxWidth; }
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.65));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

window.previewImage = (url) => {
    const html = `
        <div class="relative">
            <img src="${url}" class="w-full max-h-[70vh] object-contain rounded-2xl shadow-2xl">
            <button class="w-full mt-4 py-3 bg-gray-100 rounded-xl font-bold btn-press text-xs" onclick="window.closeModal(this)">Close</button>
        </div>
    `;
    renderModalHTML(html);
};

window.triggerScamWarning = (encodedUrl) => {
    const rawUrl = decodeURIComponent(encodedUrl);
    const html = `
        <div class="text-center space-y-3">
            <div class="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto text-xl"><i class="fas fa-shield-alt"></i></div>
            <h3 class="text-base font-bold text-gray-900">Scam Alert</h3>
            <p class="text-xs text-gray-500">External links may be unsafe. Continue only if you trust the destination.</p>
            <p class="text-[11px] font-mono bg-gray-100 p-2 rounded-xl text-gray-700 break-all select-all">${rawUrl}</p>
            <div class="flex gap-2 pt-2">
                <button onclick="window.closeModal(this)" class="flex-1 py-3 bg-gray-100 text-gray-700 font-bold rounded-xl text-xs btn-press">Cancel</button>
                <button onclick="window.confirmOpenLink('${encodeURIComponent(rawUrl)}', this)" class="flex-1 py-3 bg-red-600 text-white font-bold rounded-xl text-xs btn-press shadow-md">Open Link</button>
            </div>
        </div>
    `;
    renderModalHTML(html);
};

window.confirmOpenLink = (encUrl, btn) => { window.open(decodeURIComponent(encUrl), '_blank', 'noopener,noreferrer'); window.closeModal(btn); };
window.toggleChatMenu = (e) => { e.stopPropagation(); document.getElementById('chat-menu-dropdown')?.classList.toggle('hidden'); };

window.openChatLinkHistory = () => {
    const msgsContainer = document.getElementById('messages-container');
    const aTags = msgsContainer ? msgsContainer.querySelectorAll('a.web-link') : [];
    let listHtml = '';
    aTags.forEach(a => {
        const url = a.textContent;
        listHtml += `
            <div class="p-2.5 bg-gray-50 rounded-xl flex items-center justify-between border border-gray-100 mb-1.5">
                <div class="min-w-0 flex-1 pr-2"><a href="javascript:void(0)" onclick="window.triggerScamWarning('${encodeURIComponent(url)}')" class="text-xs font-bold text-blue-600 truncate block">${url}</a></div>
                <i class="fas fa-external-link-alt text-gray-400 text-xs"></i>
            </div>
        `;
    });
    const html = `
        <div class="space-y-3">
            <h3 class="text-base font-bold flex items-center gap-2"><i class="fas fa-link text-blue-500"></i> Shared Links</h3>
            <div class="max-h-60 overflow-y-auto no-scrollbar space-y-2">${listHtml || '<p class="text-xs text-gray-400 text-center py-6">No links shared in this conversation.</p>'}</div>
            <button onclick="window.closeModal(this)" class="w-full py-2.5 bg-gray-100 rounded-xl font-bold text-xs btn-press">Close</button>
        </div>
    `;
    renderModalHTML(html);
};

window.toggleEnterIsSend = (checked) => { enterIsSend = checked; localStorage.setItem('chatrix_enter_is_send', checked ? 'true' : 'false'); window.showToast(`Enter is send: ${checked ? 'ON' : 'OFF'}`); };

window.playAudio = (btn, url) => {
    const icon = btn.querySelector('i');
    if (btn._audio && !btn._audio.paused) { btn._audio.pause(); icon.className = 'fas fa-play'; return; }
    if (!btn._audio) { btn._audio = new Audio(url); btn._audio.onended = () => { icon.className = 'fas fa-play'; }; }
    btn._audio.play().catch(() => {}); icon.className = 'fas fa-pause';
};
