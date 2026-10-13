import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
    getAuth, 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    onAuthStateChanged, 
    signOut, 
    updatePassword, 
    deleteUser 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    getFirestore, 
    collection, 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc, 
    addDoc, 
    getDocs, 
    onSnapshot, 
    query, 
    where, 
    orderBy, 
    deleteDoc, 
    serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
    getStorage, 
    ref, 
    uploadBytes, 
    getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// ==========================================
// 1. FIREBASE INITIALIZATION & STATE
// ==========================================
const fbCfg = window.__FB_CFG || {
    apiKey: "dummy",
    authDomain: "chatrix.firebaseapp.com",
    projectId: "chatrix",
    storageBucket: "chatrix.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abcdef"
};

const app = initializeApp(fbCfg);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// Application State
window.currentUser = null;
let currentChatUser = null;
let activeUnsubMessages = null;
let activeUnsubChats = null;
let activeUnsubStories = null;
let activeUnsubPacks = null;
let activeBanCountdownInterval = null;

let chatSelectionMode = false;
let selectedChatIds = new Set();
let replyingToMessage = null;

// Temporary Sticker Studio Canvas State
let stickerCanvas = null;
let stickerCtx = null;
let isStickerPainting = false;
let stickerBrushActive = true;
let currentActivePackId = null;

// Temporary Story State
let storyCanvas = null;
let storyCtx = null;
let isStoryPainting = false;
let storyBrushActive = false;

// Custom Profile Color State (Dual Color)
let profileColorMode = 'solid'; // 'solid' or 'gradient'
let profileTempColor1 = '#3b82f6';
let profileTempColor2 = '';
let profileTempTickColor = 'text-blue-500';
let profileTempIcon = '';

// ==========================================
// 2. RATE LIMITING & SECURITY GUARDS
// ==========================================

// Track rapid reload (2 Hour Ban on spam)
(function enforceReloadRateLimit() {
    try {
        const now = Date.now();
        const RELOAD_KEY = 'chatrix_reload_history';
        let history = JSON.parse(localStorage.getItem(RELOAD_KEY) || '[]');
        // Keep timestamps within last 12 seconds
        history = history.filter(ts => now - ts < 12000);
        history.push(now);
        localStorage.setItem(RELOAD_KEY, JSON.stringify(history));

        if (history.length > 7) {
            // Trigger 2-hour local ban
            const banExpiry = now + (2 * 60 * 60 * 1000);
            localStorage.setItem('chatrix_local_ban', JSON.stringify({
                reason: "Suspicious activity detected: rapid app reloads.",
                expiresAt: banExpiry,
                type: "temp"
            }));
            localStorage.removeItem(RELOAD_KEY);
        }
    } catch(e) {}
})();

// Check if user is currently banned (Local or Firestore)
function evaluateBanState(userData) {
    const now = Date.now();
    let isBanned = false;
    let reason = "Violation of terms or suspicious activity.";
    let expiresAt = null;
    let isPermanent = false;

    // Check Local Rate-Limit Ban first
    try {
        const localBanRaw = localStorage.getItem('chatrix_local_ban');
        if (localBanRaw) {
            const localBan = JSON.parse(localBanRaw);
            if (localBan.expiresAt > now) {
                isBanned = true;
                reason = localBan.reason;
                expiresAt = localBan.expiresAt;
            } else {
                localStorage.removeItem('chatrix_local_ban');
            }
        }
    } catch(e) {}

    // Check Server/Admin Ban
    if (userData && (userData.isBanned || userData.banned)) {
        isBanned = true;
        reason = userData.banReason || "Your account has been administratively suspended.";
        if (userData.banExpiresAt) {
            const serverExpiry = typeof userData.banExpiresAt.toMillis === 'function' 
                ? userData.banExpiresAt.toMillis() 
                : new Date(userData.banExpiresAt).getTime();
            if (serverExpiry > now) {
                expiresAt = serverExpiry;
            } else {
                isBanned = false; // Expired
            }
        } else {
            isPermanent = true;
        }
    }

    if (isBanned) {
        lockdownBannedUser(reason, expiresAt, isPermanent, userData);
        return true;
    }

    // Not banned -> unlock UI
    document.body.classList.remove('is-user-banned');
    const overlay = document.getElementById('banned-overlay');
    if (overlay) overlay.classList.add('hidden');
    if (activeBanCountdownInterval) {
        clearInterval(activeBanCountdownInterval);
        activeBanCountdownInterval = null;
    }
    return false;
}

// STRICT ANTI-BYPASS LOCKDOWN
function lockdownBannedUser(reason, expiresAt, isPermanent, userData) {
    // 1. Apply body class so CSS removes all access even if overlay is deleted in DevTools
    document.body.classList.add('is-user-banned');

    // 2. Unsubscribe all real-time listeners and clear DOM messages
    if (activeUnsubMessages) { activeUnsubMessages(); activeUnsubMessages = null; }
    if (activeUnsubChats) { activeUnsubChats(); activeUnsubChats = null; }
    if (activeUnsubStories) { activeUnsubStories(); activeUnsubStories = null; }
    if (activeUnsubPacks) { activeUnsubPacks(); activeUnsubPacks = null; }

    const msgContainer = document.getElementById('messages-container');
    if (msgContainer) msgContainer.innerHTML = '';
    const chatList = document.getElementById('chat-list');
    if (chatList) chatList.innerHTML = '';

    // 3. Render Ban Screen
    const overlay = document.getElementById('banned-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.style.display = 'flex';
        
        document.getElementById('banned-name').innerText = userData?.name || "Member";
        document.getElementById('banned-username').innerText = userData?.username ? `@${userData.username}` : "@account";
        if (userData?.photoURL) document.getElementById('banned-dp').src = userData.photoURL;

        document.getElementById('ban-reason-text').innerText = reason;
        const badge = document.getElementById('ban-type-badge');
        const timerEl = document.getElementById('ban-countdown-timer');

        if (isPermanent) {
            badge.innerText = "Permanent Administrative Ban";
            badge.className = "inline-block mt-1 text-[9px] font-bold px-2 py-0.5 rounded-full bg-red-600 text-white";
            timerEl.innerText = "PERMANENT";
        } else {
            badge.innerText = "Temporary Restriction";
            badge.className = "inline-block mt-1 text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300";

            function updateTimer() {
                const diff = expiresAt - Date.now();
                if (diff <= 0) {
                    timerEl.innerText = "Expired. Please refresh.";
                    clearInterval(activeBanCountdownInterval);
                    localStorage.removeItem('chatrix_local_ban');
                    window.location.reload();
                    return;
                }
                const hrs = Math.floor(diff / 3600000);
                const mins = Math.floor((diff % 3600000) / 60000);
                const secs = Math.floor((diff % 60000) / 1000);
                timerEl.innerText = `${String(hrs).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
            }

            if (activeBanCountdownInterval) clearInterval(activeBanCountdownInterval);
            updateTimer();
            activeBanCountdownInterval = setInterval(updateTimer, 1000);
        }
    }
}

// 5-Hour Ban for repeated premium request spam
function enforcePremiumRateLimit() {
    const key = 'chatrix_premium_submits';
    const now = Date.now();
    let history = JSON.parse(localStorage.getItem(key) || '[]');
    history = history.filter(ts => now - ts < 60000); // 1 min window
    history.push(now);
    localStorage.setItem(key, JSON.stringify(history));

    if (history.length >= 3) {
        const banExpiry = now + (5 * 60 * 60 * 1000); // 5 hours
        localStorage.setItem('chatrix_local_ban', JSON.stringify({
            reason: "Excessive premium verification requests submitted.",
            expiresAt: banExpiry,
            type: "temp"
        }));
        evaluateBanState(window.currentUser);
        return true;
    }
    return false;
}

// ==========================================
// 3. UI HELPERS & NOTIFICATIONS
// ==========================================
window.showToast = function(msg, icon = 'fa-info-circle') {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-msg');
    const toastIcon = document.getElementById('toast-icon');
    if (!toast) return;

    toastMsg.textContent = msg;
    toastIcon.innerHTML = `<i class="fas ${icon}"></i>`;
    toast.classList.remove('-translate-y-[200%]');
    toast.classList.add('translate-y-2');

    setTimeout(() => {
        toast.classList.remove('translate-y-2');
        toast.classList.add('-translate-y-[200%]');
    }, 2800);
};

window.copyToClipboard = function(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        window.showToast("Copied to clipboard!", "fa-check");
    }).catch(() => {
        window.showToast("Failed to copy", "fa-times");
    });
};

function formatChatTime(date) {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ==========================================
// 4. AUTHENTICATION & PROFILE
// ==========================================
onAuthStateChanged(auth, async (user) => {
    const splash = document.getElementById('splash-screen');
    const loginView = document.getElementById('login-view');
    const signupView = document.getElementById('signup-view');
    const mainApp = document.getElementById('main-app');

    if (user) {
        try {
            const userDocSnap = await getDoc(doc(db, "users", user.uid));
            if (userDocSnap.exists()) {
                window.currentUser = { uid: user.uid, ...userDocSnap.data() };
            } else {
                window.currentUser = {
                    uid: user.uid,
                    name: user.displayName || "User",
                    username: user.email?.split('@')[0] || "user",
                    photoURL: user.photoURL || "https://placehold.co/150",
                    bio: "Trust once lost is never found again.",
                    createdAt: serverTimestamp()
                };
                await setDoc(doc(db, "users", user.uid), window.currentUser, { merge: true });
            }

            // Check Ban state immediately
            if (evaluateBanState(window.currentUser)) {
                if (splash) splash.classList.add('opacity-0', 'pointer-events-none');
                return;
            }

            // Real-time listener for current user document (picks up live admin bans or updates)
            onSnapshot(doc(db, "users", user.uid), (snapshot) => {
                if (snapshot.exists()) {
                    window.currentUser = { uid: user.uid, ...snapshot.data() };
                    if (evaluateBanState(window.currentUser)) return;
                    syncProfileUI();
                }
            });

            // Transition into main application
            loginView.classList.replace('view-visible', 'view-hidden');
            signupView.classList.replace('view-visible', 'view-hidden');
            mainApp.classList.replace('view-hidden', 'view-visible');
            
            initChatEngine();
            initStoriesFeed();
            initStickerEngine();
            syncProfileUI();
        } catch (err) {
            console.error("Auth hydration error:", err);
            window.showToast("Connection issue occurred", "fa-exclamation-triangle");
        }
    } else {
        window.currentUser = null;
        mainApp.classList.replace('view-visible', 'view-hidden');
        loginView.classList.replace('view-hidden', 'view-visible');
    }

    if (splash) {
        setTimeout(() => splash.classList.add('opacity-0', 'pointer-events-none'), 350);
    }
});

// LOGIN LOGIC
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const usernameInput = document.getElementById('login-username').value.trim().replace(/\s+/g, '');
    const password = document.getElementById('login-password').value;
    const errorBox = document.getElementById('login-error');
    errorBox.classList.add('hidden');

    try {
        let email = usernameInput;
        if (!usernameInput.includes('@')) {
            // Find user by username
            const q = query(collection(db, "users"), where("username", "==", usernameInput.toLowerCase()));
            const snap = await getDocs(q);
            if (snap.empty) {
                throw new Error("No account found with this username.");
            }
            email = snap.docs[0].data().email || `${usernameInput.toLowerCase()}@chatrix.app`;
        }
        await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
        errorBox.textContent = err.message || "Failed to sign in.";
        errorBox.classList.remove('hidden');
    }
});

// SIGNUP LOGIC WITH 5MB DP & STRICT USERNAME CHECK
document.getElementById('signup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('signup-name').value.trim();
    let username = document.getElementById('signup-username').value.trim().replace(/\s+/g, '').toLowerCase();
    const password = document.getElementById('signup-password').value;
    const dpInput = document.getElementById('signup-dp');
    const errorBox = document.getElementById('signup-error');
    errorBox.classList.add('hidden');

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        errorBox.textContent = "Username must be 3-20 characters without spaces or symbols.";
        errorBox.classList.remove('hidden');
        return;
    }

    // Check DP file size <= 5MB
    let photoURL = "https://placehold.co/150";
    if (dpInput.files && dpInput.files[0]) {
        const file = dpInput.files[0];
        if (file.size > 5 * 1024 * 1024) {
            errorBox.textContent = "Profile photo exceeds 5MB size limit!";
            errorBox.classList.remove('hidden');
            return;
        }
    }

    try {
        // Check username uniqueness
        const userCheck = await getDocs(query(collection(db, "users"), where("username", "==", username)));
        if (!userCheck.empty) {
            throw new Error("This username is already taken. Please choose another.");
        }

        const email = `${username}@chatrix.app`;
        const cred = await createUserWithEmailAndPassword(auth, email, password);

        // Upload DP if selected
        if (dpInput.files && dpInput.files[0]) {
            const file = dpInput.files[0];
            const fileRef = ref(storage, `avatars/${cred.user.uid}_${Date.now()}`);
            await uploadBytes(fileRef, file);
            photoURL = await getDownloadURL(fileRef);
        }

        const userPayload = {
            uid: cred.user.uid,
            name,
            username,
            email,
            photoURL,
            bio: "Trust once lost is never found again.",
            birthday: "",
            color: "from-blue-500 to-blue-600",
            tickColor: "text-blue-500",
            icon: "",
            createdAt: serverTimestamp()
        };

        await setDoc(doc(db, "users", cred.user.uid), userPayload);
    } catch (err) {
        errorBox.textContent = err.message || "Failed to create account.";
        errorBox.classList.remove('hidden');
    }
});

// DP Preview Handling with 5MB validation
document.getElementById('signup-dp')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        window.showToast("File exceeds 5MB limit", "fa-exclamation-circle");
        e.target.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
        const preview = document.getElementById('dp-preview');
        const icon = document.getElementById('dp-icon');
        preview.src = ev.target.result;
        preview.classList.remove('hidden');
        if (icon) icon.classList.add('hidden');
    };
    reader.readAsDataURL(file);
});

// Profile DP Change (Settings/Profile Tab)
document.getElementById('change-dp-input')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !window.currentUser) return;
    if (file.size > 5 * 1024 * 1024) {
        window.showToast("Photo exceeds 5MB limit", "fa-times-circle");
        return;
    }
    try {
        window.showToast("Uploading new photo...", "fa-spinner fa-spin");
        const fileRef = ref(storage, `avatars/${window.currentUser.uid}_${Date.now()}`);
        await uploadBytes(fileRef, file);
        const url = await getDownloadURL(fileRef);
        await updateDoc(doc(db, "users", window.currentUser.uid), { photoURL: url });
        window.showToast("Photo updated!", "fa-check");
    } catch(err) {
        window.showToast("Failed to upload photo", "fa-times");
    }
});

// Switch Between Auth Pages
document.getElementById('go-to-signup')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-view').classList.replace('view-visible', 'view-hidden');
    document.getElementById('signup-view').classList.replace('view-hidden', 'view-visible');
});

document.getElementById('go-to-login')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('signup-view').classList.replace('view-visible', 'view-hidden');
    document.getElementById('login-view').classList.replace('view-hidden', 'view-visible');
});

// Ban Appeal
window.submitBanAppeal = async function(text) {
    if (!text || text.trim().split(/\s+/).length < 25) return;
    try {
        await addDoc(collection(db, "ban_appeals"), {
            uid: window.currentUser?.uid || "unauthenticated",
            username: window.currentUser?.username || "unknown",
            reason: text.trim(),
            timestamp: serverTimestamp()
        });
        window.showToast("Appeal submitted for review.", "fa-check-circle");
        document.getElementById('appeal-modal').classList.add('hidden');
    } catch(e) {
        window.showToast("Failed to submit appeal.", "fa-times");
    }
};

// Sync profile elements
function syncProfileUI() {
    if (!window.currentUser) return;
    const u = window.currentUser;

    const profileDp = document.getElementById('profile-dp');
    const settingsDp = document.getElementById('settings-top-dp');
    if (profileDp && u.photoURL) profileDp.src = u.photoURL;
    if (settingsDp && u.photoURL) settingsDp.src = u.photoURL;

    const profileName = document.getElementById('profile-name');
    const settingsName = document.getElementById('settings-top-name');
    if (profileName) profileName.innerText = u.name || "User";
    if (settingsName) settingsName.innerText = u.name || "User";

    const profileUsername = document.getElementById('profile-username-display');
    const settingsUsername = document.getElementById('settings-top-username');
    if (profileUsername) profileUsername.innerText = `@${u.username}`;
    if (settingsUsername) settingsUsername.innerText = `@${u.username}`;

    const bioDisplay = document.getElementById('profile-bio-display');
    if (bioDisplay) bioDisplay.innerText = u.bio || "No bio yet.";

    const bdayDisplay = document.getElementById('profile-birthday-display');
    if (bdayDisplay) bdayDisplay.innerText = u.birthday || "Add Birthday";

    // Header Background style & pattern
    applyHeaderStyle('my-profile-header-bg', 'my-profile-pattern-layer', u.color, u.icon);
    applyHeaderStyle('settings-header-bg', 'settings-pattern-layer', u.color, u.icon);
}

function applyHeaderStyle(headerId, patternId, colorStr, iconChar) {
    const header = document.getElementById(headerId);
    const pattern = document.getElementById(patternId);
    if (!header) return;

    if (!colorStr) {
        header.style.background = '';
        header.className = header.className.replace(/bg-gradient-to-r\s+from-\S+\s+to-\S+/g, '');
    } else if (colorStr.startsWith('#') || colorStr.includes('linear-gradient')) {
        header.style.background = colorStr;
    } else if (colorStr.startsWith('from-')) {
        header.style.background = '';
        header.className += ` bg-gradient-to-r ${colorStr}`;
    }

    if (pattern) {
        pattern.innerHTML = '';
        if (iconChar) {
            pattern.innerHTML = Array(18).fill(`<span class="monochrome-emoji opacity-20">${iconChar}</span>`).join('');
        }
    }
}

// ==========================================
// 5. NAVIGATION & TABS
// ==========================================
window.switchTab = function(tabName) {
    const tabs = ['home', 'stories', 'settings', 'profile'];
    tabs.forEach(t => {
        const el = document.getElementById(`${t}-tab`);
        if (el) {
            if (t === tabName) {
                el.classList.replace('tab-hidden', 'tab-visible');
            } else {
                el.classList.replace('tab-visible', 'tab-hidden');
            }
        }
    });

    document.querySelectorAll('.nav-btn').forEach(btn => {
        if (btn.getAttribute('data-target') === tabName) {
            btn.classList.add('nav-btn-active', 'text-blue-600', 'dark:text-blue-400');
            btn.classList.remove('text-gray-400');
        } else {
            btn.classList.remove('nav-btn-active', 'text-blue-600', 'dark:text-blue-400');
            btn.classList.add('text-gray-400');
        }
    });
};

// Logout & Account Delete
window.handleLogout = function() {
    window.appConfirm("Are you sure you want to log out of Chatrix?", () => {
        signOut(auth);
    });
};

window.confirmDeleteAccount = function() {
    window.appConfirm("Are you sure you want to permanently delete your account? All data will be lost forever.", async () => {
        if (!auth.currentUser) return;
        try {
            await deleteDoc(doc(db, "users", auth.currentUser.uid));
            await deleteUser(auth.currentUser);
            window.showToast("Account deleted successfully.");
        } catch(e) {
            window.showToast("Re-login required to delete account.", "fa-shield-alt");
        }
    });
};

// ==========================================
// 6. CHAT ENGINE & STICKER MESSAGING
// ==========================================
function initChatEngine() {
    if (!window.currentUser) return;
    const qChats = query(
        collection(db, "chats"), 
        where("participants", "array-contains", window.currentUser.uid)
    );

    activeUnsubChats = onSnapshot(qChats, async (snapshot) => {
        const chatListEl = document.getElementById('chat-list');
        if (!chatListEl) return;
        chatListEl.innerHTML = '';

        if (snapshot.empty) {
            chatListEl.innerHTML = `
                <div class="flex flex-col items-center justify-center p-8 text-center text-gray-400">
                    <i class="fas fa-comments text-4xl mb-3 opacity-40"></i>
                    <p class="text-xs font-semibold">No active conversations</p>
                    <p class="text-[11px] mt-1">Search for friends using the search icon above.</p>
                </div>
            `;
            return;
        }

        const chats = [];
        for (const docSnap of snapshot.docs) {
            const data = docSnap.data();
            const otherUid = data.participants.find(id => id !== window.currentUser.uid);
            chats.push({ id: docSnap.id, otherUid, ...data });
        }

        // Render Chat Cards
        for (const chat of chats) {
            const userSnap = await getDoc(doc(db, "users", chat.otherUid));
            const partner = userSnap.exists() ? userSnap.data() : { name: "User", photoURL: "https://placehold.co/100" };

            const card = document.createElement('div');
            card.className = "flex items-center px-4 py-3 hover:bg-gray-50 dark:hover:bg-slate-800/60 cursor-pointer border-b border-gray-100 dark:border-white/5 transition-colors";
            card.innerHTML = `
                <img src="${partner.photoURL || 'https://placehold.co/100'}" class="w-12 h-12 rounded-full object-cover mr-3 border border-gray-200 dark:border-white/10">
                <div class="flex-1 min-w-0">
                    <div class="flex justify-between items-baseline mb-0.5">
                        <h4 class="font-bold text-xs truncate text-gray-900 dark:text-white">${partner.name || 'Chatrix Member'}</h4>
                        <span class="text-[10px] text-gray-400">${chat.lastMessageTime ? formatChatTime(chat.lastMessageTime.toDate?.() || chat.lastMessageTime) : ''}</span>
                    </div>
                    <p class="text-xs text-gray-500 dark:text-gray-400 truncate">${chat.lastMessage || 'Sent an attachment'}</p>
                </div>
            `;
            card.onclick = () => window.openChatWithUser(chat.otherUid, partner);
            chatListEl.appendChild(card);
        }
    });
}

window.openChatWithUser = function(otherUid, otherUser) {
    currentChatUser = { uid: otherUid, ...otherUser };
    const chatScreen = document.getElementById('chat-screen');
    chatScreen.classList.remove('hidden');

    document.getElementById('active-chat-name').innerText = otherUser.name || "User";
    document.getElementById('active-chat-status').innerText = "Active";
    document.getElementById('active-chat-dp').src = otherUser.photoURL || "https://placehold.co/100";

    listenToChatMessages(otherUid);
};

document.getElementById('back-from-chat')?.addEventListener('click', () => {
    document.getElementById('chat-screen').classList.add('hidden');
    window.closeStickerDrawer();
    if (activeUnsubMessages) {
        activeUnsubMessages();
        activeUnsubMessages = null;
    }
});

function getChatDocId(uid1, uid2) {
    return uid1 < uid2 ? `${uid1}_${uid2}` : `${uid2}_${uid1}`;
}

function listenToChatMessages(otherUid) {
    if (activeUnsubMessages) activeUnsubMessages();
    const chatId = getChatDocId(window.currentUser.uid, otherUid);
    const qMessages = query(
        collection(db, "chats", chatId, "messages"),
        orderBy("timestamp", "asc")
    );

    activeUnsubMessages = onSnapshot(qMessages, (snapshot) => {
        const container = document.getElementById('messages-container');
        if (!container) return;
        container.innerHTML = '';

        snapshot.forEach(docSnap => {
            const msg = docSnap.data();
            const isMe = msg.senderId === window.currentUser.uid;
            const bubbleWrap = document.createElement('div');
            bubbleWrap.className = `flex flex-col ${isMe ? 'items-end' : 'items-start'} max-w-[85%] ${isMe ? 'self-end' : 'self-start'}`;

            if (msg.type === 'sticker') {
                // Sticker Bubble Display
                bubbleWrap.innerHTML = `
                    <div class="chat-sticker-bubble">
                        <img src="${msg.stickerUrl}" alt="Sticker" loading="lazy">
                    </div>
                    <span class="text-[9px] text-gray-400 mt-1 ${isMe ? 'text-right' : 'text-left'}">${formatChatTime(msg.timestamp?.toDate?.() || msg.timestamp)}</span>
                `;
            } else {
                // Standard Text Bubble
                bubbleWrap.innerHTML = `
                    <div class="px-4 py-2 rounded-2xl text-[13px] leading-relaxed break-words ${isMe ? 'chat-bubble-sent' : 'chat-bubble-received'}">
                        ${msg.text}
                    </div>
                    <span class="text-[9px] text-gray-400 mt-1 px-1">${formatChatTime(msg.timestamp?.toDate?.() || msg.timestamp)}</span>
                `;
            }

            container.appendChild(bubbleWrap);
        });
        container.scrollTop = container.scrollHeight;
    });
}

// SEND TEXT MESSAGE
async function sendTextMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !currentChatUser || !window.currentUser) return;

    input.value = '';
    const chatId = getChatDocId(window.currentUser.uid, currentChatUser.uid);

    await addDoc(collection(db, "chats", chatId, "messages"), {
        senderId: window.currentUser.uid,
        receiverId: currentChatUser.uid,
        text,
        type: 'text',
        timestamp: serverTimestamp()
    });

    await setDoc(doc(db, "chats", chatId), {
        participants: [window.currentUser.uid, currentChatUser.uid],
        lastMessage: text,
        lastMessageTime: serverTimestamp()
    }, { merge: true });
}

document.getElementById('send-btn')?.addEventListener('click', sendTextMessage);
document.getElementById('message-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendTextMessage();
    }
});

// ==========================================
// 7. STICKER STUDIO & STICKER KEYBOARD
// ==========================================

function initStickerEngine() {
    loadUserPacks();
}

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
        loadUserPacks();
    } else {
        myView.classList.add('hidden');
        discoverView.classList.remove('hidden');
        btnDiscover.className = "px-4 py-1.5 rounded-full bg-white dark:bg-white/20 text-xs font-bold text-gray-900 dark:text-white shadow-sm transition-all";
        btnMy.className = "px-4 py-1.5 rounded-full text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-all";
        loadDiscoverPacks();
    }
};

// Create Sticker Pack Prompt
window.promptCreateStickerPack = function() {
    const packName = prompt("Enter a name for your new Sticker Pack:");
    if (!packName || !packName.trim()) return;

    if (!window.currentUser) return;
    const newPack = {
        name: packName.trim(),
        authorId: window.currentUser.uid,
        authorName: window.currentUser.name,
        stickers: [],
        isPublic: true,
        createdAt: serverTimestamp()
    };

    addDoc(collection(db, "sticker_packs"), newPack).then(() => {
        window.showToast("Sticker pack created!", "fa-check");
        loadUserPacks();
    }).catch(err => {
        window.showToast("Failed to create pack", "fa-times");
    });
};

// Load user's packs (Created or Added)
async function loadUserPacks() {
    const listEl = document.getElementById('my-sticker-packs-list');
    if (!listEl || !window.currentUser) return;
    listEl.innerHTML = `<div class="p-4 text-center text-xs text-gray-400">Loading packs...</div>`;

    try {
        const q = query(collection(db, "sticker_packs"), where("authorId", "==", window.currentUser.uid));
        const snap = await getDocs(q);

        listEl.innerHTML = '';
        if (snap.empty) {
            listEl.innerHTML = `
                <div class="bg-white dark:bg-slate-800 rounded-2xl p-6 text-center border border-gray-100 dark:border-white/5">
                    <i class="fas fa-box-open text-3xl text-gray-400 mb-2"></i>
                    <p class="text-xs font-bold text-gray-700 dark:text-gray-200">No sticker packs yet</p>
                    <p class="text-[11px] text-gray-400 mt-1 mb-3">Create your first pack to draw or upload stickers.</p>
                    <button onclick="window.promptCreateStickerPack()" class="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-bold btn-press">Create Pack</button>
                </div>
            `;
            return;
        }

        snap.forEach(docSnap => {
            const pack = docSnap.data();
            const packCard = document.createElement('div');
            packCard.className = "bg-white dark:bg-slate-800 rounded-2xl p-3.5 border border-gray-100 dark:border-white/5 flex items-center justify-between shadow-sm cursor-pointer hover:border-blue-500 transition-all btn-press";
            packCard.innerHTML = `
                <div class="flex items-center gap-3">
                    <div class="w-12 h-12 rounded-xl bg-pink-50 dark:bg-pink-900/20 text-pink-500 flex items-center justify-center text-xl shrink-0 overflow-hidden">
                        ${pack.stickers?.[0] ? `<img src="${pack.stickers[0]}" class="w-full h-full object-cover">` : '<i class="fas fa-icons"></i>'}
                    </div>
                    <div>
                        <h4 class="font-extrabold text-xs text-gray-900 dark:text-white">${pack.name}</h4>
                        <p class="text-[10px] text-gray-400 font-medium">${pack.stickers?.length || 0} stickers</p>
                    </div>
                </div>
                <i class="fas fa-chevron-right text-gray-300 dark:text-gray-600 text-xs"></i>
            `;
            packCard.onclick = () => window.openStickerPackDetail(docSnap.id, pack, true);
            listEl.appendChild(packCard);
        });
    } catch(e) {
        listEl.innerHTML = `<div class="p-4 text-center text-xs text-red-400">Failed to load sticker packs.</div>`;
    }
}

// Load Discover Packs
async function loadDiscoverPacks() {
    const listEl = document.getElementById('discover-sticker-packs-list');
    if (!listEl) return;
    listEl.innerHTML = `<div class="p-4 text-center text-xs text-gray-400">Searching community packs...</div>`;

    try {
        const snap = await getDocs(query(collection(db, "sticker_packs")));
        listEl.innerHTML = '';

        snap.forEach(docSnap => {
            const pack = docSnap.data();
            const isMine = pack.authorId === window.currentUser?.uid;

            const packCard = document.createElement('div');
            packCard.className = "bg-white dark:bg-slate-800 rounded-2xl p-3.5 border border-gray-100 dark:border-white/5 flex items-center justify-between shadow-sm";
            packCard.innerHTML = `
                <div class="flex items-center gap-3 cursor-pointer" onclick="window.openStickerPackDetail('${docSnap.id}', null, false)">
                    <div class="w-12 h-12 rounded-xl bg-purple-50 dark:bg-purple-900/20 text-purple-500 flex items-center justify-center text-xl shrink-0 overflow-hidden">
                        ${pack.stickers?.[0] ? `<img src="${pack.stickers[0]}" class="w-full h-full object-cover">` : '<i class="fas fa-icons"></i>'}
                    </div>
                    <div>
                        <h4 class="font-extrabold text-xs text-gray-900 dark:text-white">${pack.name}</h4>
                        <p class="text-[10px] text-gray-400 font-medium">By @${pack.authorName || 'user'} • ${pack.stickers?.length || 0} stickers</p>
                    </div>
                </div>
                <div class="flex items-center gap-1.5">
                    <button class="px-3 py-1.5 rounded-full text-xs font-bold ${isMine ? 'bg-gray-100 dark:bg-slate-700 text-gray-400' : 'bg-blue-600 text-white'} btn-press" onclick="window.toggleAddPackToCollection('${docSnap.id}')">
                        ${isMine ? 'Mine' : 'Add Pack'}
                    </button>
                </div>
            `;
            listEl.appendChild(packCard);
        });
    } catch(e) {
        listEl.innerHTML = `<div class="p-4 text-center text-xs text-red-400">Failed to load public packs.</div>`;
    }
}

// Open Pack Details & 4x4 Grid
window.openStickerPackDetail = async function(packId, packData = null, isOwner = true) {
    currentActivePackId = packId;
    const modal = document.getElementById('sticker-pack-detail-modal');
    modal.classList.remove('hidden');
    modal.style.display = 'flex';

    if (!packData) {
        const snap = await getDoc(doc(db, "sticker_packs", packId));
        packData = snap.data();
    }

    document.getElementById('pack-detail-title').innerText = packData.name;
    document.getElementById('pack-detail-count').innerText = `${packData.stickers?.length || 0} Stickers`;

    const makeBtn = document.getElementById('pack-detail-make-btn');
    if (makeBtn) {
        makeBtn.style.display = (packData.authorId === window.currentUser?.uid) ? 'flex' : 'none';
    }

    const grid = document.getElementById('pack-detail-stickers-grid');
    grid.innerHTML = '';

    if (!packData.stickers || packData.stickers.length === 0) {
        grid.innerHTML = `<div class="col-span-4 text-center py-10 text-gray-400 text-xs">No stickers in this pack yet.</div>`;
        return;
    }

    packData.stickers.forEach((url, idx) => {
        const item = document.createElement('div');
        item.className = "sticker-item-box relative group";
        item.innerHTML = `
            <img src="${url}" alt="Sticker ${idx}">
            ${packData.authorId === window.currentUser?.uid ? `
                <button class="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full text-[9px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" onclick="event.stopPropagation(); window.deleteStickerFromPack(${idx})">
                    <i class="fas fa-times"></i>
                </button>
            ` : ''}
        `;
        grid.appendChild(item);
    });
};

window.closeStickerPackDetail = function() {
    const modal = document.getElementById('sticker-pack-detail-modal');
    modal.classList.add('hidden');
    modal.style.display = 'none';
};

// 512x512 CANVAS STICKER MAKER
window.openStickerMakerModal = function() {
    const modal = document.getElementById('sticker-maker-modal');
    modal.classList.remove('hidden');
    modal.style.display = 'flex';

    stickerCanvas = document.getElementById('sticker-draw-canvas');
    stickerCtx = stickerCanvas.getContext('2d');
    
    // Clear & Set Transparent Canvas
    stickerCtx.clearRect(0, 0, 512, 512);

    setupStickerDrawingEvents();
};

window.closeStickerMakerModal = function() {
    const modal = document.getElementById('sticker-maker-modal');
    modal.classList.add('hidden');
    modal.style.display = 'none';
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
    if (stickerCtx) {
        stickerCtx.clearRect(0, 0, 512, 512);
    }
};

window.promptAddStickerText = function() {
    const text = prompt("Enter text to add to sticker:");
    if (!text || !text.trim() || !stickerCtx) return;

    const color = document.getElementById('sticker-brush-color')?.value || '#ffffff';
    stickerCtx.font = 'bold 42px Inter, sans-serif';
    stickerCtx.fillStyle = color;
    stickerCtx.textAlign = 'center';
    stickerCtx.textBaseline = 'middle';
    stickerCtx.fillText(text.trim(), 256, 256);
};

// Import Image / GIF (Only Image or GIF, Strictly No Audio/Video, Limit 5MB)
document.getElementById('sticker-import-file')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Check size limit (5MB)
    if (file.size > 5 * 1024 * 1024) {
        window.showToast("File size exceeds 5MB limit", "fa-exclamation-triangle");
        e.target.value = '';
        return;
    }

    // Check mime type (Only Image or GIF)
    if (!file.type.startsWith('image/')) {
        window.showToast("Only Image and GIF formats are supported", "fa-ban");
        e.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            // Draw image scaled to fit 512x512
            const hRatio = 512 / img.width;
            const vRatio = 512 / img.height;
            const ratio = Math.min(hRatio, vRatio);
            const centerShiftX = (512 - img.width * ratio) / 2;
            const centerShiftY = (512 - img.height * ratio) / 2;
            stickerCtx.drawImage(img, 0, 0, img.width, img.height,
                centerShiftX, centerShiftY, img.width * ratio, img.height * ratio);
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

// Save Done Sticker to Pack
window.saveCreatedSticker = async function() {
    if (!stickerCanvas || !currentActivePackId) return;

    const doneBtn = document.getElementById('done-sticker-btn');
    if (doneBtn) {
        doneBtn.disabled = true;
        doneBtn.innerText = "Saving...";
    }

    stickerCanvas.toBlob(async (blob) => {
        try {
            const fileName = `stickers/${currentActivePackId}_${Date.now()}.png`;
            const fileRef = ref(storage, fileName);
            await uploadBytes(fileRef, blob);
            const stickerUrl = await getDownloadURL(fileRef);

            const packRef = doc(db, "sticker_packs", currentActivePackId);
            const packSnap = await getDoc(packRef);
            if (packSnap.exists()) {
                const currentStickers = packSnap.data().stickers || [];
                currentStickers.push(stickerUrl);
                await updateDoc(packRef, { stickers: currentStickers });
            }

            window.showToast("Sticker created successfully!", "fa-check");
            window.closeStickerMakerModal();
            window.openStickerPackDetail(currentActivePackId);
        } catch(err) {
            window.showToast("Failed to save sticker", "fa-times");
        } finally {
            if (doneBtn) {
                doneBtn.disabled = false;
                doneBtn.innerText = "Done";
            }
        }
    }, 'image/png');
};

// Delete sticker from pack
window.deleteStickerFromPack = async function(index) {
    if (!currentActivePackId) return;
    try {
        const packRef = doc(db, "sticker_packs", currentActivePackId);
        const packSnap = await getDoc(packRef);
        if (packSnap.exists()) {
            const stickers = packSnap.data().stickers || [];
            stickers.splice(index, 1);
            await updateDoc(packRef, { stickers });
            window.openStickerPackDetail(currentActivePackId);
        }
    } catch(e) {
        window.showToast("Failed to delete sticker", "fa-times");
    }
};

// ==========================================
// 8. CHAT STICKER DRAWER & 4x4 KEYBOARD
// ==========================================
window.toggleStickerDrawer = function() {
    const drawer = document.getElementById('chat-sticker-drawer');
    if (drawer.classList.contains('hidden')) {
        drawer.classList.remove('hidden');
        drawer.style.display = 'flex';
        loadStickerDrawerPacks();
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

async function loadStickerDrawerPacks() {
    const tabsContainer = document.getElementById('sticker-drawer-packs-tabs');
    const gridContainer = document.getElementById('sticker-drawer-grid');
    if (!tabsContainer || !gridContainer) return;

    tabsContainer.innerHTML = '';
    gridContainer.innerHTML = '';

    try {
        const snap = await getDocs(query(collection(db, "sticker_packs")));
        if (snap.empty) {
            gridContainer.innerHTML = `<div class="col-span-4 text-center py-6 text-xs text-gray-400">No sticker packs available. Click + to create one!</div>`;
            return;
        }

        const packs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        packs.forEach((pack, index) => {
            const tabBtn = document.createElement('button');
            tabBtn.className = `px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap btn-press ${index === 0 ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-slate-800 text-gray-500'}`;
            tabBtn.innerText = pack.name;
            tabBtn.onclick = () => {
                tabsContainer.querySelectorAll('button').forEach(b => {
                    b.className = 'px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap btn-press bg-gray-100 dark:bg-slate-800 text-gray-500';
                });
                tabBtn.className = 'px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap btn-press bg-blue-600 text-white';
                renderStickerDrawer4x4(pack);
            };
            tabsContainer.appendChild(tabBtn);
        });

        // Render first pack by default
        renderStickerDrawer4x4(packs[0]);
    } catch(e) {
        gridContainer.innerHTML = `<div class="col-span-4 text-center py-6 text-xs text-red-400">Failed to load stickers.</div>`;
    }
}

function renderStickerDrawer4x4(pack) {
    const grid = document.getElementById('sticker-drawer-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!pack.stickers || pack.stickers.length === 0) {
        grid.innerHTML = `<div class="col-span-4 text-center py-6 text-xs text-gray-400">No stickers in this pack.</div>`;
        return;
    }

    pack.stickers.forEach(url => {
        const item = document.createElement('div');
        item.className = "sticker-item-box";
        item.innerHTML = `<img src="${url}" alt="Sticker">`;
        item.onclick = () => window.sendStickerMessage(url);
        grid.appendChild(item);
    });
}

// Send Sticker as Message
window.sendStickerMessage = async function(stickerUrl) {
    if (!currentChatUser || !window.currentUser) return;
    const chatId = getChatDocId(window.currentUser.uid, currentChatUser.uid);

    try {
        await addDoc(collection(db, "chats", chatId, "messages"), {
            senderId: window.currentUser.uid,
            receiverId: currentChatUser.uid,
            stickerUrl,
            type: 'sticker',
            timestamp: serverTimestamp()
        });

        await setDoc(doc(db, "chats", chatId), {
            participants: [window.currentUser.uid, currentChatUser.uid],
            lastMessage: "Sent a sticker",
            lastMessageTime: serverTimestamp()
        }, { merge: true });

        window.closeStickerDrawer();
    } catch(e) {
        window.showToast("Failed to send sticker", "fa-times");
    }
};

// ==========================================
// 9. DUAL COLOR PICKER (SOLID OR GRADIENT)
// ==========================================
window.openAdvancedColorPicker = function() {
    const overlay = document.getElementById('profile-color-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';

    if (window.currentUser) {
        document.getElementById('color-preview-name').innerText = window.currentUser.name;
        if (window.currentUser.photoURL) document.getElementById('color-preview-dp').src = window.currentUser.photoURL;
        updateColorPreviewLive();
    }
};

window.closeAdvancedColorPicker = function() {
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
    if (hex1) hex1.innerText = profileTempColor1;
    if (hex2) hex2.innerText = profileTempColor2 || 'None (Solid)';

    updateColorPreviewLive();
};

window.clearColor2 = function() {
    profileTempColor2 = '';
    const hex2 = document.getElementById('hex-2-display');
    if (hex2) hex2.innerText = 'None (Solid)';
    updateColorPreviewLive();
};

function updateColorPreviewLive() {
    const previewBg = document.getElementById('color-preview-bg');
    const label = document.getElementById('custom-color-mode-label');
    if (!previewBg) return;

    if (profileTempColor2 && profileTempColor2 !== profileTempColor1) {
        // Gradient Mode
        previewBg.style.background = `linear-gradient(135deg, ${profileTempColor1} 0%, ${profileTempColor2} 100%)`;
        if (label) label.innerText = "Mode: 2 Colors (Gradient)";
    } else {
        // Solid Mode
        previewBg.style.background = profileTempColor1;
        if (label) label.innerText = "Mode: 1 Color (Solid)";
    }
}

window.selectLiveColor = function(btn) {
    const grad = btn.getAttribute('data-grad');
    const previewBg = document.getElementById('color-preview-bg');
    if (!previewBg) return;

    if (grad) {
        profileTempColor1 = grad;
        profileTempColor2 = '';
        previewBg.className = previewBg.className.replace(/bg-gradient-to-\S+\s+from-\S+\s+to-\S+/g, '');
        previewBg.className += ` bg-gradient-to-r ${grad}`;
        previewBg.style.background = '';
    } else {
        profileTempColor1 = '#4b5563';
        profileTempColor2 = '';
        previewBg.style.background = '#4b5563';
    }
};

window.selectTickColor = function(colorClass) {
    profileTempTickColor = colorClass;
    window.showToast("Verified tick color selected!", "fa-check");
};

window.selectProfileIcon = function(iconChar) {
    profileTempIcon = iconChar;
    const status = document.getElementById('current-icon-status');
    if (status) status.innerText = iconChar ? `Active (${iconChar})` : 'Off';

    const pattern = document.getElementById('color-preview-pattern-layer');
    if (pattern) {
        pattern.innerHTML = iconChar ? Array(18).fill(`<span class="monochrome-emoji opacity-20">${iconChar}</span>`).join('') : '';
    }
};

window.applyAdvancedProfileColor = async function() {
    if (!window.currentUser) return;

    let finalColor = profileTempColor1;
    if (profileTempColor2 && profileTempColor2 !== profileTempColor1) {
        finalColor = `linear-gradient(135deg, ${profileTempColor1} 0%, ${profileTempColor2} 100%)`;
    }

    try {
        await updateDoc(doc(db, "users", window.currentUser.uid), {
            color: finalColor,
            tickColor: profileTempTickColor,
            icon: profileTempIcon
        });
        window.showToast("Profile styling saved!", "fa-check");
        window.closeAdvancedColorPicker();
    } catch(e) {
        window.showToast("Failed to update profile style", "fa-times");
    }
};

window.resetAdvancedProfileColor = async function() {
    if (!window.currentUser) return;
    try {
        await updateDoc(doc(db, "users", window.currentUser.uid), {
            color: 'from-blue-500 to-blue-600',
            tickColor: 'text-blue-500',
            icon: ''
        });
        window.showToast("Profile style reset to default");
        window.closeAdvancedColorPicker();
    } catch(e) {}
};

// ==========================================
// 10. PREMIUM VERIFICATION & SUPPORT
// ==========================================
document.getElementById('premium-btn-action')?.addEventListener('click', async () => {
    // Check if user is spamming premium requests -> 5 Hour Ban
    if (enforcePremiumRateLimit()) return;

    window.appConfirm("Submit request for Chatrix Premium VIP verification?", async () => {
        try {
            await addDoc(collection(db, "premium_requests"), {
                uid: window.currentUser.uid,
                username: window.currentUser.username,
                timestamp: serverTimestamp()
            });
            window.showToast("Premium verification request submitted!", "fa-star");
        } catch(e) {
            window.showToast("Submission failed", "fa-times");
        }
    });
});

window.contactSupportInApp = function() {
    window.openChatWithUser("support_official", {
        name: "Chatrix Support Team",
        photoURL: "https://placehold.co/100",
        username: "support"
    });
};

// ==========================================
// 11. GLOBAL SEARCH OVERLAY
// ==========================================
window.openSearchOverlay = function() {
    const v = document.getElementById('search-view');
    if (v) v.classList.remove('hidden');
    document.getElementById('global-search-input')?.focus();
};

window.closeSearchOverlay = function() {
    const v = document.getElementById('search-view');
    if (v) v.classList.add('hidden');
};

document.getElementById('global-search-input')?.addEventListener('input', async (e) => {
    const qText = e.target.value.trim().toLowerCase();
    const resultsContainer = document.getElementById('search-results-list');
    if (!qText || !resultsContainer) {
        if (resultsContainer) resultsContainer.innerHTML = '';
        return;
    }

    try {
        const snap = await getDocs(collection(db, "users"));
        resultsContainer.innerHTML = '';

        snap.forEach(docSnap => {
            const u = docSnap.data();
            if (u.uid === window.currentUser?.uid) return;
            if (u.name?.toLowerCase().includes(qText) || u.username?.toLowerCase().includes(qText)) {
                const item = document.createElement('div');
                item.className = "flex items-center px-5 py-3 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer border-b border-gray-100 dark:border-white/5";
                item.innerHTML = `
                    <img src="${u.photoURL || 'https://placehold.co/100'}" class="w-10 h-10 rounded-full object-cover mr-3">
                    <div class="flex-1 min-w-0">
                        <p class="font-bold text-xs text-gray-900 dark:text-white">${u.name}</p>
                        <p class="text-[11px] text-gray-400">@${u.username}</p>
                    </div>
                `;
                item.onclick = () => {
                    window.closeSearchOverlay();
                    window.openChatWithUser(u.uid, u);
                };
                resultsContainer.appendChild(item);
            }
        });
    } catch(err) {}
});

// ==========================================
// 12. STORIES ENGINE
// ==========================================
function initStoriesFeed() {
    const feed = document.getElementById('stories-feed-container');
    if (!feed) return;
    feed.innerHTML = `
        <div class="flex flex-col items-center justify-center py-12 text-center text-gray-400">
            <i class="fas fa-circle-notch text-4xl mb-3 opacity-30"></i>
            <p class="text-xs font-semibold">No recent stories</p>
            <p class="text-[11px] mt-1">Tap Add Story to share moments with friends.</p>
        </div>
    `;
}

window.openStoryEditor = function() {
    const overlay = document.getElementById('story-editor-overlay');
    if (overlay) overlay.classList.remove('hidden');
};

window.closeStoryEditor = function() {
    const overlay = document.getElementById('story-editor-overlay');
    if (overlay) overlay.classList.add('hidden');
};

// Birthday & Profile Edit Prompts
window.promptEditBirthday = function() {
    const bday = prompt("Enter your birthday (e.g. 15 August 2004):", window.currentUser?.birthday || '');
    if (bday !== null && window.currentUser) {
        updateDoc(doc(db, "users", window.currentUser.uid), { birthday: bday.trim() });
    }
};

window.openModernEditModal = function(field) {
    if (!window.currentUser) return;
    if (field === 'name') {
        const val = prompt("Enter your new display name:", window.currentUser.name || '');
        if (val && val.trim()) {
            updateDoc(doc(db, "users", window.currentUser.uid), { name: val.trim() });
        }
    } else if (field === 'bio') {
        const val = prompt("Enter your new bio:", window.currentUser.bio || '');
        if (val !== null) {
            updateDoc(doc(db, "users", window.currentUser.uid), { bio: val.trim() });
        }
    } else if (field === 'username') {
        let val = prompt("Enter new username (no spaces):", window.currentUser.username || '');
        if (val) {
            val = val.trim().replace(/\s+/g, '').toLowerCase();
            if (/^[a-zA-Z0-9_]{3,20}$/.test(val)) {
                updateDoc(doc(db, "users", window.currentUser.uid), { username: val });
            } else {
                window.showToast("Invalid username format", "fa-exclamation-triangle");
            }
        }
    }
};
