/**
 * app.js - StreetRank 3.0 Native Logic
 * Re-engineered for App Shell Architecture and Native UX.
 */

import { auth, db } from './firebase.js';
import {
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
  doc, getDoc, getDocs, updateDoc, addDoc, deleteDoc,
  collection, query, orderBy, limit, where,
  onSnapshot, arrayUnion, serverTimestamp, GeoPoint, increment
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// --- Global State ---
let currentUser = null;
let currentUserData = null;
let userCoords = null;
let activeListeners = [];
let activeChallengeId = null;
let activeChallengeData = null;
let processedFights = new Set();

const loader = document.getElementById('loader');

// --- Haptic / Vibrate ---
const haptic = (type = 50) => {
  if (navigator.vibrate) navigator.vibrate(type);
};

// --- Auth Initialization ---
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = 'index.html';
    return;
  }
  currentUser = user;

  // Global user listener
  const userRef = doc(db, 'users', user.uid);
  const unsubUser = onSnapshot(userRef, (snap) => {
    if (snap.exists()) {
      currentUserData = snap.data();
      if (!currentUserData.profileComplete) {
        window.location.href = 'profile-setup.html';
        return;
      }
      renderSidebar(currentUserData);
      if (document.getElementById('sectionFights').classList.contains('active')) loadMyFights();
    }
  }, (err) => console.error("Error User Snapshot:", err));
  activeListeners.push(unsubUser);

  initApp();
});

function initApp() {
  startGlobalListeners();
  requestLocationSilent();
  if (loader) loader.classList.add('hidden');
}

// --- Real-time Listeners ---
function startGlobalListeners() {
  const userSnap = activeListeners[0];
  activeListeners.slice(1).forEach(unsub => unsub());
  activeListeners = [userSnap];

  // 1. Ranking
  const qRanking = query(collection(db, 'users'), orderBy('score', 'desc'), limit(50));
  activeListeners.push(onSnapshot(qRanking, (snap) => {
    renderRankingList(snap.docs);
  }));

  // 2. Received Challenges
  const qReceived = query(collection(db, 'challenges'), where('toUid', '==', currentUser.uid));
  activeListeners.push(onSnapshot(qReceived, (snap) => {
    const activeDocs = snap.docs.filter(d => ['pending','postponed'].includes(d.data().status));
    updateNotifBadges(activeDocs.length);
    
    // Auto-modal on new challenge
    snap.docChanges().forEach(change => {
      const c = change.doc.data();
      if (change.type === 'added' && c.status === 'pending') {
        const modal = document.getElementById('challengeModal');
        if (!modal.classList.contains('open')) {
          showChallengeModal({ id: change.doc.id, ...c });
        }
      }
    });

    if (document.getElementById('sectionNotifications').classList.contains('active')) refreshNotificationsUI();
  }));

  // 3. Sent Challenges Feedback
  const qSent = query(collection(db, 'challenges'), where('fromUid', '==', currentUser.uid));
  activeListeners.push(onSnapshot(qSent, (snap) => {
    snap.docChanges().forEach(change => {
      if (change.type === 'modified') {
        const c = change.doc.data();
        if (c.status === 'accepted') {
          haptic([100, 50, 100]);
          showToast('success', '¡A PELEAR!', `${c.toApodo} aceptó tu reto.`);
        }
        if (c.status === 'rejected') showToast('warning', 'Reto Rechazado', `${c.toApodo} no quiso pelear.`);
      }
    });
    if (document.getElementById('sectionNotifications').classList.contains('active')) refreshNotificationsUI();
  }));

  // 4. Consensus Check
  const qFights = query(
    collection(db, 'fights'),
    where('status', '==', 'waiting_report'),
    where('players', 'array-contains', currentUser.uid)
  );
  activeListeners.push(onSnapshot(qFights, (snap) => {
    snap.docs.forEach(d => {
      const f = d.data();
      if (f.reportA && f.reportB && f.status === 'waiting_report') {
        processConsensus(d.id, f);
      }
    });
    renderPendingFights(snap);
  }));
}

// --- Challenge Actions ---
window.rejectChallenge = async function() {
  if (!activeChallengeId) return;
  haptic(20);
  try {
    const penalty = 10;
    const newScore = Math.max(100, (currentUserData.score || 1000) - penalty);
    await updateDoc(doc(db, 'users', currentUser.uid), { score: newScore, updatedAt: serverTimestamp() });
    await updateDoc(doc(db, 'challenges', activeChallengeId), { status: 'rejected' });
    showToast('info', 'Cobardía...', `Perdiste ${penalty} pts.`);
    closeChallengeModal();
  } catch (err) { showToast('error', 'Error', 'Fallo técnico.'); }
};

window.postponeChallenge = async function() {
  if (!activeChallengeId) return;
  haptic(10);
  try {
    await updateDoc(doc(db, 'challenges', activeChallengeId), { status: 'postponed', timestamp: serverTimestamp() });
    showToast('info', 'Pospuesto', 'Rival avisado. Tienes 1h para aceptar.');
    closeChallengeModal();
  } catch (err) { showToast('error', 'Error', 'No se pudo posponer.'); }
};

window.acceptChallenge = async function() {
  if (!activeChallengeId || !activeChallengeData) return;
  haptic([50, 20, 50]);
  try {
    const fromUserSnap = await getDoc(doc(db, 'users', activeChallengeData.fromUid));
    if (!fromUserSnap.exists()) throw new Error("Peleador no encontrado.");
    const fromUserData = fromUserSnap.data();

    await updateDoc(doc(db, 'challenges', activeChallengeId), { status: 'accepted' });
    
    await addDoc(collection(db, 'fights'), {
      playerA: activeChallengeData.fromUid, playerAApodo: activeChallengeData.fromApodo, playerAScore: activeChallengeData.fromScore,
      playerAPhoto: fromUserData.photoURL || '',
      playerB: currentUser.uid, playerBApodo: currentUserData.apodo, playerBScore: currentUserData.score || 1000,
      playerBPhoto: currentUserData.photoURL || '',
      players: [activeChallengeData.fromUid, currentUser.uid],
      status: 'waiting_report', reportA: null, reportB: null, processedA: false, processedB: false,
      createdAt: serverTimestamp()
    });
    
    showToast('success', '¡DESAFÍO ACEPTADO!', 'Reporta el resultado tras la pelea.');
    closeChallengeModal();
  } catch (err) { showToast('error', 'Error', err.message); }
};

window.withdrawChallenge = async function(id) {
  haptic(10);
  try {
    await deleteDoc(doc(db, 'challenges', id));
    showToast('info', 'Retirado', 'Desafío cancelado.');
    refreshNotificationsUI();
  } catch (err) { showToast('error', 'Error', 'No se pudo retirar.'); }
};

// --- Consensus Logic ---
function renderPendingFights(snap) {
  const container = document.getElementById('pendingFightsReport');
  if (!container) return;
  const pending = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (pending.length === 0) { container.innerHTML = ''; return; }
  
  container.innerHTML = `
    <div class="pending-fight-container animate-in">
      <div class="pending-header">⚔️ RESULTADO PENDIENTE</div>
      <div class="pending-list">
        ${pending.map(f => {
          const isA = f.playerA === currentUser.uid;
          const rep = isA ? f.reportA : f.reportB;
          const opp = isA ? f.playerBApodo : f.playerAApodo;
          if (rep) return `<div class="pending-waiting">⏳ Esperando a <strong>${opp}</strong>...</div>`;
          return `
            <div class="pending-item">
              <span class="vs-text">vs <strong>${opp}</strong></span>
              <div class="report-btns">
                <button class="btn btn-success btn-sm" onclick="reportFight('${f.id}','win')">🏆</button>
                <button class="btn btn-secondary btn-sm" onclick="reportFight('${f.id}','draw')">🤝</button>
                <button class="btn btn-danger btn-sm" onclick="reportFight('${f.id}','loss')">💀</button>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
}

window.reportFight = async function(id, res) {
  haptic(30);
  try {
    const isA = (await getDoc(doc(db, 'fights', id))).data().playerA === currentUser.uid;
    await updateDoc(doc(db, 'fights', id), isA ? { reportA: res } : { reportB: res });
    showToast('info', 'Reportado', 'Esperando rival...');
  } catch (err) { showToast('error', 'Error', 'No se pudo enviar.'); }
};

async function processConsensus(id, f) {
  const isA = f.playerA === currentUser.uid;
  const alreadyDone = isA ? f.processedA : f.processedB;
  if (alreadyDone || processedFights.has(`${id}-${currentUser.uid}`)) return;

  const rA = f.reportA; const rB = f.reportB;
  const valid = (rA==='win' && rB==='loss') || (rA==='loss' && rB==='win') || (rA==='draw' && rB==='draw');

  if (valid) {
    processedFights.add(`${id}-${currentUser.uid}`);
    const myOld = isA ? f.playerAScore : f.playerBScore;
    const oppOld = isA ? f.playerBScore : f.playerAScore;
    const resValue = (isA ? rA : rB) === 'win' ? 1 : (isA ? rA : rB) === 'draw' ? 0.5 : 0;
    const diff = Math.round(32 * (resValue - (1 / (1 + Math.pow(10, (oppOld - myOld) / 400)))));
    const myRes = isA ? rA : rB;

    const userUp = { score: Math.max(100, myOld + diff), updatedAt: serverTimestamp(), fights: arrayUnion({
      opponent: isA ? f.playerBApodo : f.playerAApodo,
      opponentPhoto: isA ? f.playerBPhoto : f.playerAPhoto,
      resultado: myRes, puntos: diff, fecha: new Date().toISOString()
    })};
    if (myRes==='win') userUp.wins = increment(1); else if (myRes==='loss') userUp.losses = increment(1); else userUp.draws = increment(1);

    try {
      await updateDoc(doc(db, 'users', currentUser.uid), userUp);
      await updateDoc(doc(db, 'fights', id), isA ? { processedA: true } : { processedB: true });
      const upF = (await getDoc(doc(db, 'fights', id))).data();
      if (upF.processedA && upF.processedB) await updateDoc(doc(db, 'fights', id), { status: 'completed' });
      haptic(100);
      showToast('success', '¡Consenso!', `${diff >= 0 ? '+' : ''}${diff} ELO.`);
    } catch(e) { processedFights.delete(`${id}-${currentUser.uid}`); }
  } else {
    await updateDoc(doc(db, 'fights', id), { status: 'disputed' });
    showToast('error', 'Conflicto', 'Resultados contradictorios.');
  }
}

// --- Dynamic Rendering ---
function renderRankingList(docs) {
  const tbody = document.getElementById('rankingBody');
  if (!tbody) return;
  const isMobile = window.innerWidth <= 768;
  const html = docs.map((d, i) => {
    const f = d.data(); const isMe = f.uid === currentUser.uid; const lv = getLevel(f.score || 1000);
    if (isMobile) {
      return `
        <tr class="ranking-row-mobile animate-in ${isMe ? 'is-me' : ''}">
          <td class="pos-cell">${i+1}</td>
          <td class="avatar-cell">
            <img src="${f.photoURL || ''}" class="ranking-avatar"/>
          </td>
          <td class="user-info-cell">
            <strong>${escHtml(f.apodo)}</strong>
            <div class="meta">
              <span class="level-badge ${lv.cls}" style="font-size:0.5rem;padding:1px 4px;">${lv.label}</span>
              <span>• ${escHtml(f.ciudad || 'Calle')}</span>
            </div>
          </td>
          <td class="score-cell-mobile">
            <span>${f.score || 1000}</span>
            <small>ELO</small>
          </td>
        </tr>`;
    } else {
      // RESTAURADO DESKTOP ORIGINAL
      return `
        <tr class="animate-in" style="${isMe ? 'background:rgba(192,57,43,0.15); border-left: 2px solid var(--red-primary);' : ''}">
          <td>${i+1}</td>
          <td>
            <div style="display:flex;align-items:center;gap:0.75rem;">
              <img src="${f.photoURL || ''}" style="width:34px;height:34px;border-radius:50%;border:1px solid var(--border-color);"/>
              <strong style="color:var(--text-primary);">${escHtml(f.apodo)}</strong>
            </div>
          </td>
          <td><span class="score-badge">${f.score || 1000}</span></td>
          <td>${f.wins || 0}W / ${f.losses || 0}L</td>
          <td>${escHtml(f.pais || '—')}</td>
        </tr>`;
    }
  }).join('');
  tbody.innerHTML = html;
}

async function refreshNotificationsUI() {
  const container = document.getElementById('notificationsContent');
  if (!container) return;
  const qR = query(collection(db, 'challenges'), where('toUid','==',currentUser.uid), limit(15));
  const qS = query(collection(db, 'challenges'), where('fromUid','==',currentUser.uid), limit(15));
  const [skR, skS] = await Promise.all([getDocs(qR), getDocs(qS)]);
  const rec = skR.docs.map(d=>({id:d.id, ...d.data()})).filter(c=>['pending','postponed'].includes(c.status));
  const sent = skS.docs.map(d=>({id:d.id, ...d.data()})).filter(c=>['pending','postponed'].includes(c.status));
  
  if (!rec.length && !sent.length) { container.innerHTML = '<div class="empty-state"><h3>Sin novedades</h3></div>'; return; }
  
  container.innerHTML = `
    <div class="notification-list">
      ${rec.map(c => `
        <div class="notification-item animate-in">
          <div style="flex:1;">
            <strong>${escHtml(c.fromApodo)}</strong>
            <small style="display:block;opacity:0.6;">${c.status==='postponed'?'⏳ Pospuesto':'🥊 Te desafía'}</small>
          </div>
          <div style="display:flex;gap:5px;">
            <button class="btn btn-success btn-sm" onclick="acceptFromList('${c.id}')">SI</button>
            <button class="btn btn-danger btn-sm" onclick="rejectFromList('${c.id}')">NO</button>
          </div>
        </div>`).join('')}
      ${sent.map(c => `
        <div class="notification-item animate-in" style="opacity:0.75;">
          <div style="flex:1;">
            <strong>A ${escHtml(c.toApodo)}</strong>
            <small style="display:block;opacity:0.6;">${c.status==='postponed'?'Lo pospuso':'🕒 Pendiente'}</small>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="withdrawChallenge('${c.id}')">Retirar</button>
        </div>`).join('')}
    </div>`;
}

// --- Public Window Functions ---
window.showSection = function(name) {
  haptic(10);
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-menu-item').forEach(m => m.classList.remove('active'));
  const sc = document.getElementById(`section${name.charAt(0).toUpperCase() + name.slice(1)}`);
  const mn = document.getElementById(`menu${name.charAt(0).toUpperCase() + name.slice(1)}`);
  if (sc) sc.classList.add('active');
  if (mn) mn.classList.add('active');
  if (name === 'fights') loadMyFights();
  if (name === 'notifications') refreshNotificationsUI();
  
  // Soporte para scroll en Desktop y Mobile
  window.scrollTo(0, 0); 
  const mc = document.querySelector('.main-content');
  if (mc) mc.scrollTop = 0;
};

window.loadMyFights = () => {
  const el = document.getElementById('fightsContent'); if (!el || !currentUserData) return;
  const fts = currentUserData.fights || [];
  if (!fts.length) { el.innerHTML = '<div class="empty-state"><h3>Sin peleas registradas</h3></div>'; return; }
  
  // RESTAURADO DESKTOP ORIGINAL (fight-history-grid + fight-card-rich)
  el.innerHTML = `<div class="fight-history-grid">${fts.slice().reverse().map(f => {
    const resClass = f.resultado || 'draw';
    const resText = f.resultado === 'win' ? 'GANADA' : f.resultado === 'loss' ? 'PERDIDA' : 'EMPATE';
    const diff = f.puntos !== undefined ? f.puntos : 0;
    const dateStr = f.fecha ? new Date(f.fecha).toLocaleDateString() : '—';
    
    return `
      <div class="fight-card-rich ${resClass} animate-in">
        <div class="fight-card-header">
           <span class="fight-date">📅 ${dateStr}</span>
           <span class="fight-result-badge">${resText}</span>
        </div>
        <div class="fight-card-body">
           <div class="opponent-info">
              <img src="${f.opponentPhoto || ''}" class="opp-avatar"/>
              <div>
                <div class="opp-apodo">${escHtml(f.opponent)}</div>
                <div class="opp-score">Rival Score: ${f.opponentScore || '—'}</div>
              </div>
           </div>
           <div class="score-delta">
              <div class="delta-value">${diff >= 0 ? '+' : ''}${diff}</div>
              <div class="delta-label">ELO</div>
           </div>
        </div>
      </div>`;
  }).join('')}</div>`;
};

window.findNearbyFighters = async function() {
  const el = document.getElementById('nearbyContent'); if (!userCoords) { showToast('warning','GPS','Activa tu ubicación.'); return; }
  el.innerHTML = '<div class="skeleton-shimmer" style="height:200px;border-radius:20px;"></div>';
  try {
    const snap = await getDocs(query(collection(db,'users'), limit(50)));
    const nearby = [];
    snap.forEach(d => {
      const f = d.data(); if(f.uid === currentUser.uid || !f.location) return;
      const dist = haversineKm(userCoords.lat, userCoords.lng, f.location.latitude, f.location.longitude);
      if(dist <= 50) nearby.push({...f, dist});
    });
    if(!nearby.length) { el.innerHTML = '<div class="empty-state"><h3>No hay nadie en el radar</h3></div>'; return; }
    
    // RESTAURADO DESKTOP ORIGINAL (fighters-grid + fighter-card)
    el.innerHTML = `<div class="fighters-grid">${nearby.sort((a,b)=>a.dist-b.dist).map(f => `
      <div class="fighter-card animate-in" onclick="sendChallenge('${f.uid}','${f.apodo}',${f.score||1000})">
        <img src="${f.photoURL || ''}" class="fighter-card-avatar"/>
        <div class="fighter-card-apodo">"${escHtml(f.apodo)}"</div>
        <div class="fighter-card-name">${escHtml(f.nombre)}</div>
        <div class="fighter-card-score">${f.score || 1000}</div>
        <div class="fighter-card-location">📍 a ${f.dist.toFixed(1)} km</div>
        <div class="mt-1">
          <button class="btn btn-primary btn-sm btn-full">⚔️ RETAR</button>
        </div>
      </div>`).join('')}</div>`;
  } catch(e){ console.error(e); }
};

window.sendChallenge = async function(uid, apodo, score) {
  haptic(40);
  try {
    const q1 = query(collection(db,'challenges'), where('fromUid','==',currentUser.uid), where('toUid','==',uid));
    const q2 = query(collection(db,'challenges'), where('fromUid','==',uid), where('toUid','==',currentUser.uid));
    const [s1, s2] = await Promise.all([getDocs(q1), getDocs(q2)]);
    if([...s1.docs, ...s2.docs].some(d => ['pending','postponed'].includes(d.data().status))) {
      showToast('warning','Espera','Ya hay un desafío activo.'); return;
    }
    await addDoc(collection(db, 'challenges'), {
      fromUid: currentUser.uid, fromApodo: currentUserData.apodo, fromScore: currentUserData.score || 1000,
      toUid: uid, toApodo: apodo, toScore: score, status: 'pending', timestamp: serverTimestamp()
    });
    showToast('success','¡Lanzado!','Espera su respuesta.');
  } catch(e){ showToast('error','Error','No se pudo enviar.'); }
};

// --- Missing functions for dashboard.html ---
window.markAllRead = () => showToast('info','Notificaciones','Todo marcado como leído.');
window.closeFightModal = () => document.getElementById('fightModal').classList.remove('open');
window.closeOpponentModal = () => document.getElementById('opponentModal').classList.remove('open');
window.closeChallengeModal = () => document.getElementById('challengeModal').classList.remove('open');
window.acceptFromList = async (id) => { 
  const s = await getDoc(doc(db,'challenges',id)); 
  if(s.exists()){ activeChallengeId=id; activeChallengeData=s.data(); acceptChallenge(); } 
};
window.rejectFromList = (id) => { activeChallengeId=id; rejectChallenge(); };
window.handleLogout = async () => { await signOut(auth); window.location.href='index.html'; };

// --- Helpers ---
function getLevel(s){
  if(s>=2000) return {label:'🔥 LEYENDA',cls:'level-legend'};
  if(s>=1500) return {label:'👑 CAMPEÓN',cls:'level-champion'};
  if(s>=1250) return {label:'⚡ BRAWLER',cls:'level-brawler'};
  if(s>=1100) return {label:'🥋 FIGHTER',cls:'level-fighter'};
  return {label:'🆕 ROOKIE',cls:'level-rookie'};
}
function updateNotifBadges(c){
  const sb = document.getElementById('sidebarNotifBadge'); const nb = document.getElementById('navNotifBadge');
  if(c > 0){ if(sb){sb.textContent=c; sb.classList.remove('hidden');} if(nb){nb.classList.remove('hidden'); document.getElementById('notifCount').textContent=c;}}
  else{ if(sb)sb.classList.add('hidden'); if(nb)nb.classList.add('hidden');}
}
function showChallengeModal(c){
  haptic([50,50,50]); activeChallengeId=c.id; activeChallengeData=c;
  document.getElementById('challengerName').textContent=`"${c.fromApodo}"`;
  document.getElementById('challengerScore').textContent=`Score: ${c.fromScore}`;
  document.getElementById('challengeModal').classList.add('open');
}
function showToast(t,ti,m){
  const icos={success:'✅',error:'❌',warning:'⚠️',info:'ℹ️'};
  const toast=document.createElement('div'); toast.className=`toast ${t}`;
  toast.innerHTML=`<span class="toast-icon">${icos[t]||'ℹ️'}</span><div class="toast-content"><div class="toast-title">${ti}</div><div class="toast-message">${m}</div></div>`;
  const cnt=document.getElementById('toastContainer'); if(cnt){cnt.appendChild(toast); setTimeout(()=>{toast.classList.add('fade-out'); setTimeout(()=>toast.remove(),300);},3000);}
}
window.requestLocation = function(){
  if(!navigator.geolocation) return;
  const b=document.getElementById('locationBanner'); if(b){const btn=b.querySelector('button'); btn.disabled=true; btn.textContent='GPS...';}
  navigator.geolocation.getCurrentPosition(pos=>{
    userCoords={lat:pos.coords.latitude, lng:pos.coords.longitude}; updateUserLocation(userCoords);
    if(b) b.style.display='none'; showToast('success','LOCALIZADO','Rivaliza ya.');
  }, err=>{ showToast('error','GPS','Error de ubicación.'); if(b){const btn=b.querySelector('button'); btn.disabled=false; btn.textContent='Activar GPS';}}, {timeout:10000});
};
function requestLocationSilent(){ if(navigator.geolocation) navigator.geolocation.getCurrentPosition(pos=>{userCoords={lat:pos.coords.latitude, lng:pos.coords.longitude};updateUserLocation(userCoords);},()=>{},{timeout:10000}); }
async function updateUserLocation(c){ try{await updateDoc(doc(db,'users',currentUser.uid),{location:new GeoPoint(c.lat,c.lng),lastLocationUpdate:serverTimestamp()});}catch(e){} }
function haversineKm(l1,g1,l2,g2){ const R=6371; const dL=(l2-l1)*Math.PI/180; const dG=(g2-g1)*Math.PI/180; const a=Math.sin(dL/2)**2+Math.cos(l1*Math.PI/180)*Math.cos(l2*Math.PI/180)*Math.sin(dG/2)**2; return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)); }
function renderSidebar(d){
  const av=document.getElementById('sidebarAvatar'); if(av) av.src=d.photoURL||'';
  const navAv=document.getElementById('navAvatar'); if(navAv){navAv.src=d.photoURL||''; navAv.style.display='block';}
  const sn=document.getElementById('sidebarName'); if(sn) sn.textContent=d.nombre;
  const sa=document.getElementById('sidebarApodo'); if(sa) sa.textContent=`"${d.apodo}"`;
  const ss=document.getElementById('sidebarScore'); if(ss) ss.textContent=d.score||1000;
  const w=d.wins||0; const l=d.losses||0; const dr=d.draws||0; const tot=w+l+dr; const wr=tot>0?Math.round(w/tot*100):0;
  if(document.getElementById('sidebarWins')) document.getElementById('sidebarWins').textContent=w;
  if(document.getElementById('sidebarLosses')) document.getElementById('sidebarLosses').textContent=l;
  if(document.getElementById('sidebarWinRate')) document.getElementById('sidebarWinRate').textContent=`${wr}%`;
}
function escHtml(s){return s?String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m])): '';}

// Gestures
let touchStartY = 0;
document.getElementById('challengeModal').addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
document.getElementById('challengeModal').addEventListener('touchmove', (e) => {
  const diff = e.touches[0].clientY - touchStartY;
  if (diff > 100) { closeChallengeModal(); haptic(10); }
}, { passive: true });
