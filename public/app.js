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

  // Listener para los datos del usuario actual
  const userRef = doc(db, 'users', user.uid);
  const unsubUser = onSnapshot(userRef, (snap) => {
    if (snap.exists()) {
      currentUserData = snap.data();
      if (!currentUserData.profileComplete) {
        window.location.href = 'profile-setup.html';
        return;
      }
      renderSidebar(currentUserData);
    }
  });
  activeListeners.push(unsubUser);

  initApp();
});

function initApp() {
  loadRanking();
  startGlobalListeners();
  requestLocationSilent();
  if (loader) loader.classList.add('hidden');
}

// --- Listeners de tiempo real ---
function startGlobalListeners() {
  const qReceived = query(collection(db, 'challenges'), where('toUid', '==', currentUser.uid));
  const qSent = query(collection(db, 'challenges'), where('fromUid', '==', currentUser.uid));
  
  // Recibidos
  activeListeners.push(onSnapshot(qReceived, (snap) => {
    const pendingCount = snap.docs.filter(d => {
      const st = d.data().status;
      return st === 'pending' || st === 'postponed';
    }).length;
    updateNotifBadges(pendingCount);

    snap.docChanges().forEach(change => {
      if (change.type === 'added') {
        const c = change.doc.data();
        if (c.status === 'pending') {
          if (!document.getElementById('challengeModal').classList.contains('open')) {
            showChallengeModal({ id: change.doc.id, ...c });
          }
        }
      }
    });
    if (document.getElementById('sectionNotifications').classList.contains('active')) refreshNotificationsUI();
  }));

  // Enviados
  activeListeners.push(onSnapshot(qSent, (snap) => {
    snap.docChanges().forEach(change => {
      if (change.type === 'modified') {
        const c = change.doc.data();
        if (c.status === 'postponed') {
          showToast('info', 'Desafío Pospuesto', `${c.toApodo} ha pospuesto tu desafío por 1h.`);
        } else if (c.status === 'rejected') {
          showToast('warning', 'Desafío Rechazado', `${c.toApodo} ha rechazado tu desafío.`);
        } else if (c.status === 'accepted') {
          showToast('success', '¡DESAFÍO ACEPTADO!', `A pelear contra ${c.toApodo}.`);
        }
      }
    });
    if (document.getElementById('sectionNotifications').classList.contains('active')) refreshNotificationsUI();
  }));

  // Peleas reportables
  const qFights = query(
    collection(db, 'fights'),
    where('status', '==', 'waiting_report'),
    where('players', 'array-contains', currentUser.uid)
  );
  activeListeners.push(onSnapshot(qFights, renderPendingFights));
}

// --- Lógica de Desafíos ---
window.rejectChallenge = async function() {
  if (!activeChallengeId) return;
  try {
    const penalty = 10;
    const newScore = Math.max(100, (currentUserData.score || 1000) - penalty);
    await updateDoc(doc(db, 'users', currentUser.uid), { score: newScore, updatedAt: serverTimestamp() });
    await updateDoc(doc(db, 'challenges', activeChallengeId), { status: 'rejected' });
    showToast('info', 'Cobardía detectada 💀', `Has perdido ${penalty} pts.`);
    closeChallengeModal();
  } catch (err) { console.error(err); }
};

window.postponeChallenge = async function() {
  if (!activeChallengeId) return;
  try {
    await updateDoc(doc(db, 'challenges', activeChallengeId), { status: 'postponed', timestamp: serverTimestamp() });
    showToast('info', 'Pospuesto', 'Avisado. Tienes 1h en la sección de Desafíos.');
    closeChallengeModal();
  } catch (err) { console.error(err); }
};

window.acceptChallenge = async function() {
  if (!activeChallengeId || !activeChallengeData) return;
  try {
    await updateDoc(doc(db, 'challenges', activeChallengeId), { status: 'accepted' });
    await addDoc(collection(db, 'fights'), {
      playerA: activeChallengeData.fromUid, playerAApodo: activeChallengeData.fromApodo, playerAScore: activeChallengeData.fromScore,
      playerB: currentUser.uid, playerBApodo: currentUserData.apodo, playerBScore: currentUserData.score,
      players: [activeChallengeData.fromUid, currentUser.uid],
      status: 'waiting_report', reportA: null, reportB: null, createdAt: serverTimestamp()
    });
    showToast('success', '¡Aceptado!', 'Pelead y reportad el resultado.');
    closeChallengeModal();
  } catch (err) { console.error(err); }
};

window.withdrawChallenge = async function(id) {
  try {
    await deleteDoc(doc(db, 'challenges', id));
    showToast('info', 'Retirado', 'Desafío cancelado sin penalizaciones.');
    refreshNotificationsUI();
  } catch (err) { showToast('error', 'Error', 'No se pudo retirar.'); }
};

// --- Sistema de Consenso Anti-Fallas ---
function renderPendingFights(snap) {
  const container = document.getElementById('pendingFightsReport');
  if (!container) return;
  const pending = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (pending.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <div class="card mb-2 animate-glow" style="border-left: 5px solid var(--gold);">
      <div class="card-header"><span class="card-title">⚔️ Reportar Resultado de Pelea</span></div>
      <div class="p-1">
        ${pending.map(f => {
          const isMeA = f.playerA === currentUser.uid;
          const myReport = isMeA ? f.reportA : f.reportB;
          const oppApodo = isMeA ? f.playerBApodo : f.playerAApodo;
          if (myReport) return `<p style="font-size:0.85rem;color:var(--text-muted);padding:0.5rem;">⏳ Reportado. Esperando reporte de <strong>${oppApodo}</strong>...</p>`;
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem; background:rgba(255,183,18,0.05); border-radius:8px; margin-bottom:0.5rem;">
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
    const isMeA = f.playerA === currentUser.uid;
    const update = isMeA ? { reportA: result } : { reportB: result };
    await updateDoc(fightRef, update);
    const updatedSnap = await getDoc(fightRef);
    const updatedF = updatedSnap.data();
    if (updatedF.reportA && updatedF.reportB) processConsensus(fightId, updatedF);
    else showToast('info', 'Reporte enviado', 'Esperando validación cruzada.');
  } catch (err) { showToast('error', 'Error', err.message); }
};

async function processConsensus(id, f) {
  const rA = f.reportA; const rB = f.reportB; const isMeA = f.playerA === currentUser.uid;
  const myRes = isMeA ? rA : rB;
  let valid = (rA === 'win' && rB === 'loss') || (rA === 'loss' && rB === 'win') || (rA === 'draw' && rB === 'draw');

  if (valid) {
    const myOldScore = isMeA ? f.playerAScore : f.playerBScore;
    const oppOldScore = isMeA ? f.playerBScore : f.playerAScore;
    const S = myRes === 'win' ? 1 : myRes === 'draw' ? 0.5 : 0;
    const Ea = 1 / (1 + Math.pow(10, (oppOldScore - myOldScore) / 400));
    const newScore = Math.max(100, Math.round(myOldScore + 32 * (S - Ea)));
    const diff = newScore - myOldScore;

    const updates = {
      score: newScore, updatedAt: serverTimestamp(),
      fights: arrayUnion({ opponent: isMeA ? f.playerBApodo : f.playerAApodo, resultado: myRes, puntos: diff, fecha: new Date().toISOString() })
    };
    if (myRes === 'win') updates.wins = (currentUserData.wins || 0) + 1;
    else if (myRes === 'loss') updates.losses = (currentUserData.losses || 0) + 1;
    else if (myRes === 'draw') updates.draws = (currentUserData.draws || 0) + 1;

    await updateDoc(doc(db, 'users', currentUser.uid), updates);
    await updateDoc(doc(db, 'fights', id), { status: 'completed' });
    showToast('success', '¡Validado!', `${myRes==='win'?'¡Felicidades!':''} Score: ${diff>=0?'+':''}${diff} pts.`);
    loadRanking();
  } else {
    await updateDoc(doc(db, 'fights', id), { status: 'disputed' });
    showToast('error', '⚠️ FRAUDE', 'Los reportes no coinciden. Pelea anulada.');
  }
}

// --- Bandeja de Desafíos ---
window.loadNotifications = async function() { refreshNotificationsUI(); };

async function refreshNotificationsUI() {
  const container = document.getElementById('notificationsContent');
  if (!container) return;
  container.innerHTML = '<div class="text-center p-3"><div class="spinner-sm"></div></div>';
  
  try {
    const qRec = query(collection(db, 'challenges'), where('toUid', '==', currentUser.uid), orderBy('timestamp', 'desc'), limit(15));
    const qSent = query(collection(db, 'challenges'), where('fromUid', '==', currentUser.uid), orderBy('timestamp', 'desc'), limit(15));
    const [snapRec, snapSent] = await Promise.all([getDocs(qRec), getDocs(qSent)]);
    
    const rec = snapRec.docs.map(d => ({id: d.id, ...d.data()})).filter(c => c.status==='pending' || c.status==='postponed');
    const sent = snapSent.docs.map(d => ({id: d.id, ...d.data()})).filter(c => c.status==='pending' || c.status==='postponed');

    if (!rec.length && !sent.length) {
      container.innerHTML = '<div class="empty-state"><h3>Sin desafíos</h3><p>No tienes actividad reciente.</p></div>';
      return;
    }

    container.innerHTML = `
      <div class="notification-list">
        ${rec.map(c => `
          <div class="notification-item received">
            <div class="notification-content">
              <div class="notification-title">📩 <strong>${escHtml(c.fromApodo)}</strong> te desafió</div>
              <div class="notification-time">${c.status==='postponed'?'⏳ POSPUESTO (1h)':'🆕 PENDIENTE'}</div>
            </div>
            <div style="display:flex; gap:0.5rem;">
              <button class="btn btn-success btn-sm" onclick="acceptFromList('${c.id}')">Aceptar</button>
              <button class="btn btn-danger btn-sm" onclick="rejectFromList('${c.id}')">Rechazar</button>
            </div>
          </div>`).join('')}
        ${sent.map(c => `
          <div class="notification-item sent" style="opacity:0.8;">
            <div class="notification-content">
              <div class="notification-title">📤 Desafiaste a <strong>${escHtml(c.toApodo)}</strong></div>
              <div class="notification-time">${c.status==='postponed'?'⏳ Rival lo pospuso':'🕒 Esperando respuesta...'}</div>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="withdrawChallenge('${c.id}')">Retirar</button>
          </div>`).join('')}
      </div>`;
  } catch (e) {
    console.error(e);
    container.innerHTML = '<p class="text-center p-3">Error al cargar.</p>';
  }
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
window.markAllRead = () => showToast('info', 'Hecho', 'Notificaciones procesadas.');

// --- UI / Nav / Ranking ---
function renderSidebar(d) {
  if (!d) return;
  const av = document.getElementById('sidebarAvatar');
  if (av) av.src = d.photoURL || `https://api.dicebear.com/7.x/adventurer-neutral/svg?seed=${encodeURIComponent(d.apodo)}`;
  document.getElementById('sidebarName').textContent = d.nombre;
  document.getElementById('sidebarApodo').textContent = `"${d.apodo}"`;
  document.getElementById('sidebarScore').textContent = d.score || 1000;
  
  const w = d.wins || 0; const l = d.losses || 0; const dr = d.draws || 0;
  const tot = w + l + dr; const wr = tot > 0 ? Math.round((w / tot) * 100) : 0;
  if (document.getElementById('sidebarWins')) document.getElementById('sidebarWins').textContent = w;
  if (document.getElementById('sidebarLosses')) document.getElementById('sidebarLosses').textContent = l;
  if (document.getElementById('sidebarWinRate')) document.getElementById('sidebarWinRate').textContent = `${wr}%`;
  
  const navAv = document.getElementById('navAvatar');
  if (navAv) { navAv.src = d.photoURL || ''; navAv.style.display = 'block'; }
}

window.showSection = function(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-menu-item').forEach(m => m.classList.remove('active'));
  const sc = document.getElementById(`section${name.charAt(0).toUpperCase() + name.slice(1)}`);
  const mn = document.getElementById(`menu${name.charAt(0).toUpperCase() + name.slice(1)}`);
  if (sc) sc.classList.add('active');
  if (mn) mn.classList.add('active');
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
          <td>${i+1}</td>
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
    const snap = await getDocs(query(collection(db, 'users'), limit(50)));
    const nearby = [];
    snap.forEach(d => {
      const f = d.data(); if (f.uid === currentUser.uid || !f.location) return;
      const dist = haversineKm(userCoords.lat, userCoords.lng, f.location.latitude, f.location.longitude);
      if (dist <= 50) nearby.push({ ...f, dist });
    });
    if (!nearby.length) { el.innerHTML = '<p class="text-center p-3">Nadie cerca.</p>'; return; }
    el.innerHTML = `<div class="fighters-grid">${nearby.sort((a,b)=>a.dist-b.dist).map(f => `
      <div class="fighter-card animate-in">
        <img src="${f.photoURL || 'https://api.dicebear.com/7.x/identicon/svg?seed='+f.apodo}" class="fighter-card-avatar" style="width:60px;height:60px;border-radius:50%;margin-bottom:0.5rem;border:2px solid var(--red-primary);"/>
        <div class="fighter-card-apodo">"${escHtml(f.apodo)}"</div>
        <div class="fighter-card-score">${f.score || 1000} ELO</div>
        <div class="fighter-card-location">📍 a ${f.dist.toFixed(1)} km</div>
        <button class="btn btn-primary btn-sm btn-full mt-1" onclick="sendChallenge('${f.uid}','${f.apodo}',${f.score||1000})">⚔️ Desafiar</button>
      </div>`).join('')}</div>`;
  } catch (e) { console.error(e); }
};

window.sendChallenge = async function(uid, apodo, score) {
  try {
    await addDoc(collection(db, 'challenges'), {
      fromUid: currentUser.uid, fromApodo: currentUserData.apodo, fromScore: currentUserData.score || 1000,
      toUid: uid, toApodo: apodo, toScore: score, status: 'pending', timestamp: serverTimestamp()
    });
    showToast('success', '¡Desafío Lanzado!', `Esperando respuesta de ${apodo}.`);
  } catch (e) { showToast('error', 'Error', e.message); }
};

window.loadMyFights = async function() {
  const el = document.getElementById('fightsContent'); if (!el) return;
  const fts = currentUserData.fights || [];
  if (!fts.length) { el.innerHTML = '<p class="text-center p-3">Sin peleas aún.</p>'; return; }
  el.innerHTML = `<div class="fight-list">${fts.reverse().map(f => `
    <div class="fight-item" style="border-left:3px solid ${f.resultado==='win'?'var(--success)':f.resultado==='loss'?'var(--danger)':'var(--warning)'}">
      <div><div class="apodo">vs ${escHtml(f.opponent)}</div><div class="date">${new Date(f.fecha).toLocaleDateString()}</div></div>
      <div style="text-align:right;"><div class="fight-result ${f.resultado}">${f.resultado.toUpperCase()}</div><div class="fight-score-change ${f.puntos>=0?'positive':'negative'}">${f.puntos>=0?'+':''}${f.puntos} pts</div></div>
    </div>`).join('')}</div>`;
};

// --- Helpers Finales ---
function getLevel(s) {
  if (s >= 2000) return { label: '🔥 LEYENDA', cls: 'level-legend' };
  if (s >= 1500) return { label: '👑 CAMPEÓN', cls: 'level-champion' };
  if (s >= 1250) return { label: '⚡ BRAWLER', cls: 'level-brawler' };
  if (s >= 1100) return { label: '🥋 FIGHTER', cls: 'level-fighter' };
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
window.showToast = (t, ti, msg) => {
  const ico = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  const toast = document.createElement('div'); toast.className = `toast ${t}`;
  toast.innerHTML = `<span class="toast-icon">${ico[t]||'ℹ️'}</span><div class="toast-content"><div class="toast-title">${ti}</div><div class="toast-message">${msg}</div></div>`;
  const cnt = document.getElementById('toastContainer');
  if (cnt) { cnt.appendChild(toast); setTimeout(() => { toast.classList.add('fade-out'); setTimeout(() => toast.remove(), 300); }, 4000); }
};
window.requestLocation = function() {
  if (!navigator.geolocation) return;
  const b = document.getElementById('locationBanner'); if (b) { b.querySelector('button').disabled = true; b.querySelector('button').textContent = '⏳ ...'; }
  navigator.geolocation.getCurrentPosition(pos => {
    userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude }; updateUserLocation(userCoords);
    if (b) b.style.display = 'none'; showToast('success', 'GPS OK', 'Ya puedes buscar.');
  }, err => { showToast('error', 'Error GPS', ''); if (b) b.querySelector('button').disabled = false; }, { timeout: 10000, enableHighAccuracy: true });
};
function requestLocationSilent() { if (!navigator.geolocation) return; navigator.geolocation.getCurrentPosition(pos => { userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude }; updateUserLocation(userCoords); }, ()=>{}, {timeout:10000}); }
async function updateUserLocation(c) { try { await updateDoc(doc(db, 'users', currentUser.uid), { location: new GeoPoint(c.lat, c.lng), lastLocationUpdate: serverTimestamp() }); } catch(e){} }
function haversineKm(l1, g1, l2, g2) { const R = 6371; const dL = (l2-l1)*Math.PI/180; const dG = (g2-g1)*Math.PI/180; const a = Math.sin(dL/2)**2 + Math.cos(l1*Math.PI/180)*Math.cos(l2*Math.PI/180)*Math.sin(dG/2)**2; return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); }
