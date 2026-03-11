/**
 * app.js - StreetRank Main Logic
 * Refactored for Consensus-based Fight System (Anti-Cheat)
 */

import { auth, db } from './firebase.js';
import {
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
  doc, getDoc, getDocs, updateDoc, addDoc, deleteDoc,
  collection, query, orderBy, limit, where,
  onSnapshot, arrayUnion, serverTimestamp, GeoPoint
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// --- Estado Global ---
let currentUser = null;
let currentUserData = null;
let userCoords = null;
let activeListeners = [];
let activeChallengeId = null;
let activeChallengeData = null;

const loader = document.getElementById('loader');

// --- Auth Check ---
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  currentUser = user;

  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (!snap.exists() || !snap.data().profileComplete) {
      window.location.href = 'profile-setup.html';
      return;
    }
    currentUserData = snap.data();
    initApp();
  } catch (err) {
    console.error('Error init:', err);
    showToast('error', 'Error de conexión', 'No se pudieron cargar tus datos.');
  } finally {
    if (loader) loader.classList.add('hidden');
  }
});

function initApp() {
  renderSidebar(currentUserData);
  loadRanking();
  startGlobalListeners();
  requestLocationSilent();
}

// --- Listeners de tiempo real ---
function startGlobalListeners() {
  activeListeners.forEach(unsubscribe => unsubscribe());
  activeListeners = [];

  // 1. Desafíos que YO recibo (Pendientes o Pospuestos)
  const qChallenges = query(
    collection(db, 'challenges'),
    where('toUid', '==', currentUser.uid)
  );
  
  activeListeners.push(onSnapshot(qChallenges, (snap) => {
    const validDocs = snap.docs.filter(d => {
      const data = d.data();
      // Auto-rechazo si pasó 1 hora
      if (data.status === 'pending' || data.status === 'postponed') {
        const ts = data.timestamp?.toDate ? data.timestamp.toDate() : new Date(data.timestamp);
        const diffMs = new Date() - ts;
        if (diffMs > 3600000) { // 1 hora
          autoRejectChallenge(d.id);
          return false;
        }
        return true;
      }
      return false;
    });

    updateNotifBadges(validDocs.length);
    
    // Solo mostrar modal para los NUEVOS 'pending'
    snap.docChanges().forEach(change => {
      if (change.type === 'added') {
        const c = change.doc.data();
        if (c.status === 'pending') {
          showChallengeModal({ id: change.doc.id, ...c });
        }
      }
    });

    // Refrescar lista de notificaciones si la sección está abierta
    if (document.getElementById('sectionNotifications').classList.contains('active')) {
      renderNotificationsList(snap.docs);
    }
  }));

  // 2. Peleas pendientes de reportar (Consenso)
  const qFights = query(
    collection(db, 'fights'),
    where('status', '==', 'waiting_report'),
    where('players', 'array-contains', currentUser.uid)
  );
  activeListeners.push(onSnapshot(qFights, renderPendingFights));
}

async function autoRejectChallenge(id) {
  try {
    await updateDoc(doc(db, 'challenges', id), { status: 'expired' });
  } catch(e){}
}

// --- Lógica de Desafíos y Penalizaciones ---
window.rejectChallenge = async function() {
  if (!activeChallengeId) return;
  try {
    const penalty = 10;
    const newScore = Math.max(100, (currentUserData.score || 1000) - penalty);
    await updateDoc(doc(db, 'users', currentUser.uid), { score: newScore, updatedAt: serverTimestamp() });
    await updateDoc(doc(db, 'challenges', activeChallengeId), { status: 'rejected' });
    showToast('info', 'Cobardía detectada 💀', `Has perdido ${penalty} pts por rechazar el desafío.`);
    currentUserData.score = newScore;
    renderSidebar(currentUserData);
    closeChallengeModal();
  } catch (err) { showToast('error', 'Error', err.message); }
};

window.postponeChallenge = async function() {
  if (!activeChallengeId) return;
  try {
    await updateDoc(doc(db, 'challenges', activeChallengeId), { status: 'postponed' });
    showToast('info', 'Pospuesto', 'El desafío se ha movido a tu pestaña de Desafíos. Tienes 1 hora.');
    closeChallengeModal();
  } catch (err) { showToast('error', 'Error', err.message); }
};

window.acceptChallenge = async function() {
  if (!activeChallengeId || !activeChallengeData) return;
  try {
    await updateDoc(doc(db, 'challenges', activeChallengeId), { status: 'accepted' });
    await addDoc(collection(db, 'fights'), {
      playerA: activeChallengeData.fromUid,
      playerAApodo: activeChallengeData.fromApodo,
      playerAScore: activeChallengeData.fromScore,
      playerB: currentUser.uid,
      playerBApodo: currentUserData.apodo,
      playerBScore: currentUserData.score,
      players: [activeChallengeData.fromUid, currentUser.uid],
      status: 'waiting_report',
      reportA: null, reportB: null,
      createdAt: serverTimestamp()
    });
    showToast('success', '¡Aceptado!', 'Pelead y reportad el resultado.');
    closeChallengeModal();
  } catch (err) { showToast('error', 'Error', err.message); }
};

// --- Consenso y Reporte ---
function renderPendingFights(snap) {
  const container = document.getElementById('pendingFightsReport');
  if (!container) return;
  const pending = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (pending.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <div class="card mb-2 animate-glow" style="border-left: 5px solid var(--gold);">
      <div class="card-header"><span class="card-title">⚔️ Reportar Resultado</span></div>
      <div class="p-1">
        ${pending.map(f => {
          const isA = f.playerA === currentUser.uid;
          const myReport = isA ? f.reportA : f.reportB;
          const oppApodo = isA ? f.playerBApodo : f.playerAApodo;
          if (myReport) return `<p style="font-size:0.85rem;color:var(--text-muted);padding:0.5rem;">⏳ Esperando que <strong>${oppApodo}</strong> reporte su versión...</p>`;
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem; background:rgba(255,183,0,0.05); border-radius:8px; margin-bottom:0.5rem;">
              <span style="font-size:0.9rem;">vs <strong>${oppApodo}</strong></span>
              <div style="display:flex; gap:0.5rem;">
                <button class="btn btn-success btn-sm" onclick="reportFight('${f.id}', 'win')">🏆 Gané</button>
                <button class="btn btn-secondary btn-sm" onclick="reportFight('${f.id}', 'draw')">🤝 Empate</button>
                <button class="btn btn-danger btn-sm" onclick="reportFight('${f.id}', 'loss')">💀 Perdí</button>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

window.reportFight = async function(fightId, result) {
  try {
    const fightRef = doc(db, 'fights', fightId);
    const snap = await getDoc(fightRef);
    const f = snap.data();
    const isA = f.playerA === currentUser.uid;
    const update = isA ? { reportA: result } : { reportB: result };
    await updateDoc(fightRef, update);
    const updatedSnap = await getDoc(fightRef);
    const updatedF = updatedSnap.data();
    if (updatedF.reportA && updatedF.reportB) processConsensus(fightId, updatedF);
    else showToast('info', 'Reporte enviado', 'Esperando validación de tu oponente.');
  } catch (err) { showToast('error', 'Error', err.message); }
};

async function processConsensus(id, f) {
  const rA = f.reportA; const rB = f.reportB; const isA = f.playerA === currentUser.uid;
  const myRes = isA ? rA : rB; const oppRes = isA ? rB : rA;
  let valid = (rA === 'win' && rB === 'loss') || (rA === 'loss' && rB === 'win') || (rA === 'draw' && rB === 'draw');

  if (valid) {
    const myOldScore = isA ? f.playerAScore : f.playerBScore;
    const oppOldScore = isA ? f.playerBScore : f.playerAScore;
    const S = myRes === 'win' ? 1 : myRes === 'draw' ? 0.5 : 0;
    const Ea = 1 / (1 + Math.pow(10, (oppOldScore - myOldScore) / 400));
    const newScore = Math.max(100, Math.round(myOldScore + 32 * (S - Ea)));
    const diff = newScore - myOldScore;

    const updates = {
      score: newScore, updatedAt: serverTimestamp(),
      fights: arrayUnion({ opponent: isA ? f.playerBApodo : f.playerAApodo, resultado: myRes, puntos: diff, fecha: new Date().toISOString() })
    };
    if (myRes === 'win') updates.wins = (currentUserData.wins || 0) + 1;
    else if (myRes === 'loss') updates.losses = (currentUserData.losses || 0) + 1;
    else updates.draws = (currentUserData.draws || 0) + 1;

    await updateDoc(doc(db, 'users', currentUser.uid), updates);
    await updateDoc(doc(db, 'fights', id), { status: 'completed' });
    showToast('success', '¡Pelea Verificada!', `Resultado ${myRes.toUpperCase()}. ${diff >= 0 ? '+' : ''}${diff} pts.`);
    currentUserData = { ...currentUserData, ...updates };
    renderSidebar(currentUserData);
    loadRanking();
  } else {
    await updateDoc(doc(db, 'fights', id), { status: 'disputed' });
    showToast('error', '⚠️ CONFLICTO', 'Los reportes no coinciden. Pelea anulada por fraude.');
  }
}

// --- Listado de Notificaciones ---
window.loadNotifications = async function() {
  const el = document.getElementById('notificationsContent');
  el.innerHTML = '<div class="text-center p-3"><div class="spinner-sm"></div></div>';
  const q = query(collection(db, 'challenges'), where('toUid', '==', currentUser.uid), orderBy('timestamp', 'desc'), limit(30));
  const snap = await getDocs(q);
  renderNotificationsList(snap.docs);
};

function renderNotificationsList(docs) {
  const el = document.getElementById('notificationsContent');
  if (!el) return;
  const filtered = docs.map(d => ({id: d.id, ...d.data()})).filter(c => c.status !== 'accepted' && c.status !== 'rejected');
  
  if (filtered.length === 0) {
    el.innerHTML = '<div class="empty-state"><h3>Sin desafíos</h3><p>No tienes desafíos pendientes o pospuestos.</p></div>';
    return;
  }

  el.innerHTML = `
    <div class="notification-list">
      ${filtered.map(c => `
        <div class="notification-item ${c.status === 'pending' ? 'new' : ''}">
          <div class="notification-content">
            <div class="notification-title">"${escHtml(c.fromApodo)}" te desafió</div>
            <div class="notification-time">${c.status === 'postponed' ? '⏳ POSPUESTO (1h max)' : '🆕 NUEVO'}</div>
          </div>
          <div style="display:flex; gap:0.5rem;">
            <button class="btn btn-success btn-sm" onclick="acceptFromList('${c.id}')">Aceptar</button>
            <button class="btn btn-danger btn-sm" onclick="rejectFromList('${c.id}')">Rechazar</button>
          </div>
        </div>`).join('')}
    </div>`;
}

window.acceptFromList = async function(id) {
  const snap = await getDoc(doc(db, 'challenges', id));
  activeChallengeId = id; activeChallengeData = snap.data();
  acceptChallenge();
};
window.rejectFromList = async function(id) {
  activeChallengeId = id;
  rejectChallenge();
};

// --- UI y Ranking ---
function renderSidebar(d) {
  if (!d) return;
  const avatar = document.getElementById('sidebarAvatar');
  if (avatar) avatar.src = d.photoURL || `https://api.dicebear.com/7.x/adventurer-neutral/svg?seed=${encodeURIComponent(d.apodo)}`;
  document.getElementById('sidebarName').textContent = d.nombre;
  document.getElementById('sidebarApodo').textContent = `"${d.apodo}"`;
  document.getElementById('sidebarScore').textContent = d.score || 1000;
  
  const wins = d.wins || 0; const losses = d.losses || 0; const draws = d.draws || 0;
  const total = wins + losses + draws; const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
  if (document.getElementById('sidebarWins')) document.getElementById('sidebarWins').textContent = wins;
  if (document.getElementById('sidebarLosses')) document.getElementById('sidebarLosses').textContent = losses;
  if (document.getElementById('sidebarWinRate')) document.getElementById('sidebarWinRate').textContent = `${wr}%`;
  
  const navAvatar = document.getElementById('navAvatar');
  if (navAvatar) { navAvatar.src = d.photoURL || ''; navAvatar.style.display = 'block'; }
}

window.showSection = function(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-menu-item').forEach(m => m.classList.remove('active'));
  const sec = document.getElementById(`section${name.charAt(0).toUpperCase() + name.slice(1)}`);
  const menu = document.getElementById(`menu${name.charAt(0).toUpperCase() + name.slice(1)}`);
  if (sec) sec.classList.add('active');
  if (menu) menu.classList.add('active');
  if (name === 'ranking') loadRanking();
  if (name === 'fights') loadMyFights();
  if (name === 'notifications') loadNotifications();
};

window.loadRanking = async function() {
  const tbody = document.getElementById('rankingBody');
  if (!tbody) return;
  try {
    const q = query(collection(db, 'users'), orderBy('score', 'desc'), limit(25));
    const snap = await getDocs(q);
    let html = '';
    snap.docs.forEach((doc, i) => {
      const f = doc.data(); const isMe = f.uid === currentUser.uid; const lv = getLevel(f.score || 1000);
      html += `
        <tr style="${isMe ? 'background:rgba(192,57,43,0.1);' : ''}">
          <td>${i + 1}</td>
          <td>
            <div style="display:flex;align-items:center;gap:0.5rem;">
              <img src="${f.photoURL || 'https://api.dicebear.com/7.x/identicon/svg?seed='+f.apodo}" style="width:30px;height:30px;border-radius:50%;"/>
              <strong>${escHtml(f.apodo)}</strong>
            </div>
          </td>
          <td><span class="score-badge">${f.score || 1000}</span></td>
          <td><span class="level-badge ${lv.cls}" style="font-size:0.7rem;">${lv.label}</span></td>
          <td>${escHtml(f.pais || '—')}</td>
        </tr>`;
    });
    tbody.innerHTML = html;
  } catch (e) { console.error(e); }
};

window.findNearbyFighters = async function() {
  const el = document.getElementById('nearbyContent');
  if (!userCoords) { showToast('warning', 'GPS Requerido', 'Activa tu ubicación.'); return; }
  el.innerHTML = '<div class="text-center p-3">Buscando...</div>';
  try {
    const q = query(collection(db, 'users'), limit(100));
    const snap = await getDocs(q);
    const nearby = [];
    snap.forEach(d => {
      const f = d.data(); if (f.uid === currentUser.uid || !f.location) return;
      const dist = haversineKm(userCoords.lat, userCoords.lng, f.location.latitude, f.location.longitude);
      if (dist <= 50) nearby.push({ ...f, dist });
    });
    if (nearby.length === 0) { el.innerHTML = '<p class="text-center p-3">Nadie cerca.</p>'; return; }
    el.innerHTML = `
      <div class="fighters-grid">
        ${nearby.sort((a,b)=>a.dist-b.dist).map(f => `
          <div class="fighter-card animate-in">
            <img src="${f.photoURL || 'https://api.dicebear.com/7.x/identicon/svg?seed='+f.apodo}" class="fighter-card-avatar" style="width:60px;height:60px;border-radius:50%;margin-bottom:0.5rem;border:2px solid var(--red-primary);"/>
            <div class="fighter-card-apodo">"${escHtml(f.apodo)}"</div>
            <div class="fighter-card-score">${f.score || 1000} ELO</div>
            <div class="fighter-card-location">📍 a ${f.dist.toFixed(1)} km</div>
            <button class="btn btn-primary btn-sm btn-full mt-1" onclick="sendChallenge('${f.uid}','${f.apodo}',${f.score||1000})">⚔️ Desafiar</button>
          </div>`).join('')}
      </div>`;
  } catch (e) { console.error(e); }
};

window.sendChallenge = async function(toUid, toApodo, toScore) {
  try {
    await addDoc(collection(db, 'challenges'), {
      fromUid: currentUser.uid, fromApodo: currentUserData.apodo, fromScore: currentUserData.score || 1000,
      toUid, toApodo, toScore, status: 'pending', timestamp: serverTimestamp()
    });
    showToast('success', '¡Desafío Lanzado!', `Esperando respuesta de ${toApodo}.`);
  } catch (e) { showToast('error', 'Error', e.message); }
};

window.loadMyFights = async function() {
  const el = document.getElementById('fightsContent'); if (!el) return;
  const fights = currentUserData.fights || [];
  if (fights.length === 0) { el.innerHTML = '<p class="text-center p-3">Aún no has peleado.</p>'; return; }
  el.innerHTML = `<div class="fight-list">
    ${fights.reverse().map(f => `
      <div class="fight-item" style="border-left:3px solid ${f.resultado==='win'?'var(--success)':f.resultado==='loss'?'var(--danger)':'var(--warning)'}">
        <div><div class="apodo">vs ${escHtml(f.opponent)}</div><div class="date">${new Date(f.fecha).toLocaleDateString()}</div></div>
        <div style="text-align:right;"><div class="fight-result ${f.resultado}">${f.resultado.toUpperCase()}</div><div class="fight-score-change ${f.puntos>=0?'positive':'negative'}">${f.puntos>=0?'+':''}${f.puntos} pts</div></div>
      </div>`).join('')}
  </div>`;
};

// --- Helpers Finales ---
function getLevel(score) {
  if (score >= 2000) return { label: '🔥 LEYENDA', cls: 'level-legend' };
  if (score >= 1500) return { label: '👑 CAMPEÓN', cls: 'level-champion' };
  if (score >= 1250) return { label: '⚡ BRAWLER', cls: 'level-brawler' };
  if (score >= 1100) return { label: '🥋 FIGHTER', cls: 'level-fighter' };
  return { label: '🆕 ROOKIE', cls: 'level-rookie' };
}
function updateNotifBadges(c) {
  const b = document.getElementById('sidebarNotifBadge'); const n = document.getElementById('navNotifBadge');
  if (c > 0) { if (b) { b.textContent = c; b.classList.remove('hidden'); } if (n) { n.classList.remove('hidden'); document.getElementById('notifCount').textContent = c; } }
  else { if (b) b.classList.add('hidden'); if (n) n.classList.add('hidden'); }
}
function showChallengeModal(c) {
  activeChallengeId = c.id; activeChallengeData = c;
  document.getElementById('challengerName').textContent = `"${c.fromApodo}"`;
  document.getElementById('challengerScore').textContent = `ELO: ${c.fromScore}`;
  document.getElementById('challengeModal').classList.add('open');
}
window.closeChallengeModal = () => document.getElementById('challengeModal').classList.remove('open');
window.handleLogout = async () => { await signOut(auth); window.location.href = 'index.html'; };
function escHtml(s) { return s ? String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m])) : ''; }
window.showToast = (type, title, msg) => {
  const t = document.createElement('div'); t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon"></span><div class="toast-content"><div class="toast-title">${title}</div><div class="toast-message">${msg}</div></div>`;
  document.getElementById('toastContainer').appendChild(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 300); }, 4000);
};
window.requestLocation = function() {
  if (!navigator.geolocation) return;
  const banner = document.getElementById('locationBanner'); if (banner) { banner.querySelector('button').disabled = true; banner.querySelector('button').textContent = '⏳ ...'; }
  navigator.geolocation.getCurrentPosition(pos => {
    userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude }; updateUserLocation(userCoords);
    if (banner) banner.style.display = 'none'; showToast('success', 'GPS OK', 'Ya puedes buscar.');
  }, err => { showToast('error', 'Error GPS', ''); if (banner) { banner.querySelector('button').disabled = false; } }, { timeout: 10000, enableHighAccuracy: true });
};
function requestLocationSilent() { if (!navigator.geolocation) return; navigator.geolocation.getCurrentPosition(pos => { userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude }; updateUserLocation(userCoords); }, ()=>{}, {timeout:10000}); }
async function updateUserLocation(c) { try { await updateDoc(doc(db, 'users', currentUser.uid), { location: new GeoPoint(c.lat, c.lng), lastLocationUpdate: serverTimestamp() }); } catch(e){} }
function haversineKm(l1, g1, l2, g2) { const R = 6371; const dL = (l2-l1)*Math.PI/180; const dG = (g2-g1)*Math.PI/180; const a = Math.sin(dL/2)**2 + Math.cos(l1*Math.PI/180)*Math.cos(l2*Math.PI/180)*Math.sin(dG/2)**2; return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); }
