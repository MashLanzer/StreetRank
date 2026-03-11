/**
 * app.js
 * Lógica principal del Dashboard de StreetRank.
 * Maneja:
 * - Autenticación y redirección
 * - Carga del ranking global (Firestore)
 * - Geolocalización y búsqueda de peleadores cercanos (Haversine)
 * - Sistema de desafíos en tiempo real (onSnapshot)
 * - Cálculo ELO y registro de peleas
 * - Notificaciones
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

// ─── Estado global ────────────────────────────────────────────────────────────
let currentUser = null;
let currentUserData = null;
let activeChallengeId = null;    // ID del desafío pendiente activo
let activeChallengeData = null;  // Datos del desafío pendiente
let pendingFightData = null;     // Datos de la pelea lista para registrar
let challengeListener = null;    // Listener onSnapshot para desafíos
let userCoords = null;           // { lat, lng } del usuario actual

const loader = document.getElementById('loader');

// ─── Auth check ───────────────────────────────────────────────────────────────
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
    renderSidebar(currentUserData);
    loadRanking();
    listenForChallenges();
    requestLocationSilent(); // Intenta obtener ubicación en background
  } catch (err) {
    console.error('Error al cargar datos de usuario:', err);
    showToast('error', 'Error de conexión', 'No se pudieron cargar tus datos.');
  } finally {
    loader.classList.add('hidden');
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────
window.handleLogout = async function() {
  if (challengeListener) challengeListener(); // Cancelar listener
  await signOut(auth);
  window.location.href = 'index.html';
};

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function renderSidebar(d) {
  document.getElementById('sidebarAvatar').src =
    d.photoURL || `https://api.dicebear.com/7.x/adventurer-neutral/svg?seed=${encodeURIComponent(d.apodo)}`;
  document.getElementById('sidebarName').textContent = d.nombre;
  document.getElementById('sidebarApodo').textContent = `"${d.apodo}"`;
  document.getElementById('sidebarScore').textContent = d.score || 1000;
  document.getElementById('sidebarWins').textContent = d.wins || 0;
  document.getElementById('sidebarLosses').textContent = d.losses || 0;

  const total = (d.wins || 0) + (d.losses || 0) + (d.draws || 0);
  const wr = total > 0 ? Math.round(((d.wins || 0) / total) * 100) : 0;
  document.getElementById('sidebarWinRate').textContent = `${wr}%`;

  const navAvatar = document.getElementById('navAvatar');
  if (navAvatar) {
    navAvatar.src = d.photoURL || '';
    navAvatar.style.display = 'block';
  }
}

// ─── Navegación entre secciones ───────────────────────────────────────────────
window.showSection = function(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-menu-item').forEach(m => m.classList.remove('active'));

  const sectionEl = document.getElementById(`section${capitalize(name)}`);
  const menuEl = document.getElementById(`menu${capitalize(name)}`);

  if (sectionEl) sectionEl.classList.add('active');
  if (menuEl) menuEl.classList.add('active');

  // Cargar datos al cambiar sección
  if (name === 'ranking') loadRanking();
  if (name === 'fights') loadMyFights();
  if (name === 'notifications') loadNotifications();
};

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── RANKING GLOBAL ───────────────────────────────────────────────────────────
window.loadRanking = async function() {
  const tbody = document.getElementById('rankingBody');
  tbody.innerHTML = `<tr><td colspan="5"><div style="text-align:center;padding:2rem;"><div class="spinner-sm"></div> Cargando...</div></td></tr>`;

  try {
    const q = query(collection(db, 'users'), orderBy('score', 'desc'), limit(20));
    const snap = await getDocs(q);

    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">🏆</div><h3>Sin peleadores aún</h3></div></td></tr>`;
      return;
    }

    let myRank = null;
    let html = '';

    snap.docs.forEach((d, i) => {
      const f = d.data();
      const rank = i + 1;
      if (f.uid === currentUser?.uid) myRank = rank;

      const posClass = rank === 1 ? 'top1' : rank === 2 ? 'top2' : rank === 3 ? 'top3' : '';
      const posIcon = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
      const total = (f.wins || 0) + (f.losses || 0) + (f.draws || 0);
      const photo = f.photoURL || `https://api.dicebear.com/7.x/adventurer-neutral/svg?seed=${encodeURIComponent(f.apodo)}`;
      const isMe = f.uid === currentUser?.uid;

      html += `
        <tr style="${isMe ? 'background:rgba(192,57,43,0.08);' : ''}" onclick="viewFighterProfile('${escHtml(f.uid)}')" style="cursor:pointer;">
          <td><span class="rank-pos ${posClass}">${posIcon}</span></td>
          <td>
            <div class="fighter-info">
              <img src="${escHtml(photo)}" alt="${escHtml(f.apodo)}" class="fighter-avatar-sm" loading="lazy"/>
              <div class="fighter-name-wrap">
                <div class="name">${escHtml(f.nombre)}${isMe ? ' <span style="color:var(--red-secondary);font-size:0.75rem;">(Tú)</span>' : ''}</div>
                <div class="apodo">"${escHtml(f.apodo)}"</div>
              </div>
            </div>
          </td>
          <td><span class="score-badge">${f.score || 1000}</span></td>
          <td>
            <span class="record-badge">
              <span class="w">${f.wins || 0}V</span>-
              <span class="l">${f.losses || 0}D</span>-${f.draws || 0}E
            </span>
          </td>
          <td style="font-size:0.85rem;color:var(--text-muted);">🌍 ${escHtml(f.pais || '—')}</td>
        </tr>`;
    });

    tbody.innerHTML = html;

    // Mostrar mi posición
    if (myRank && currentUserData) {
      const banner = document.getElementById('myRankBanner');
      banner.style.display = 'block';
      document.getElementById('myRankText').textContent =
        `Estás en el puesto #${myRank} con ${currentUserData.score || 1000} puntos`;
      const lv = getLevel(currentUserData.score || 1000);
      document.getElementById('myLevelBadge').innerHTML =
        `<span class="level-badge ${lv.cls}">${lv.label}</span>`;
    }

  } catch (err) {
    console.error('Error cargando ranking:', err);
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><p class="text-danger">Error al cargar ranking: ${err.message}</p></div></td></tr>`;
  }
};

// ─── GEOLOCALIZACIÓN ─────────────────────────────────────────────────────────

// Solicitar ubicación silenciosa (sin alertar al usuario si rechaza)
function requestLocationSilent() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateUserLocation(userCoords);
      // Ocultar el banner si se obtuvo la ubicación
      const banner = document.getElementById('locationBanner');
      if (banner) banner.style.display = 'none';
    },
    () => { /* Silencioso si rechaza */ },
    { timeout: 8000, maximumAge: 300000 }
  );
}

// Solicitar ubicación cuando el usuario pulsa el botón
window.requestLocation = function() {
  if (!navigator.geolocation) {
    showToast('error', 'Sin soporte', 'Tu navegador no soporta geolocalización.');
    return;
  }

  const banner = document.getElementById('locationBanner');
  if (banner) {
    banner.querySelector('button').textContent = '⏳ Obteniendo...';
    banner.querySelector('button').disabled = true;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateUserLocation(userCoords);
      if (banner) banner.style.display = 'none';
      showToast('success', 'Ubicación activada', 'Tu ubicación se ha actualizado.');
    },
    (err) => {
      const msgs = {
        1: 'Permiso de ubicación denegado. Actívalo en la configuración de tu navegador.',
        2: 'No se pudo obtener la ubicación.',
        3: 'Tiempo de espera agotado al obtener la ubicación.'
      };
      showToast('error', 'Error de ubicación', msgs[err.code] || 'Error desconocido.');
      if (banner) {
        banner.querySelector('button').textContent = 'Reintentar';
        banner.querySelector('button').disabled = false;
      }
    },
    { timeout: 10000, enableHighAccuracy: true }
  );
};

// Guardar ubicación en Firestore (solo si cambió significativamente > ~500m)
async function updateUserLocation(coords) {
  if (!currentUser) return;
  try {
    const userRef = doc(db, 'users', currentUser.uid);
    const snap = await getDoc(userRef);
    const existing = snap.data()?.location;

    if (existing) {
      const dist = haversineKm(coords.lat, coords.lng, existing.latitude, existing.longitude);
      if (dist < 0.5) return; // No actualizar si el cambio es menor a 500m
    }

    await updateDoc(userRef, {
      location: new GeoPoint(coords.lat, coords.lng),
      lastLocationUpdate: serverTimestamp()
    });
    console.log('Ubicación actualizada:', coords);
  } catch (err) {
    console.warn('No se pudo actualizar ubicación:', err.message);
  }
}

// ─── HAVERSINE: distancia entre dos coords en km ─────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Radio de la Tierra en km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) { return deg * (Math.PI / 180); }

// ─── BUSCAR PELEADORES CERCANOS ──────────────────────────────────────────────
const RADIUS_KM = 50; // Radio de búsqueda en km

window.findNearbyFighters = async function() {
  const contentEl = document.getElementById('nearbyContent');

  if (!userCoords) {
    // Intentar obtener ubicación primero
    showToast('warning', 'Ubicación necesaria', 'Por favor activa tu GPS primero.');
    window.requestLocation();
    return;
  }

  contentEl.innerHTML = `<div style="text-align:center;padding:3rem;"><div class="spinner"></div><p class="loader-text mt-2">Buscando peleadores...</p></div>`;

  try {
    // Obtener todos los usuarios con ubicación (en producción usar Geohash o Cloud Functions)
    const q = query(collection(db, 'users'), orderBy('score', 'desc'), limit(200));
    const snap = await getDocs(q);

    const nearby = [];

    snap.docs.forEach(d => {
      const f = d.data();
      if (f.uid === currentUser.uid) return; // Excluir al usuario actual
      if (!f.location) return; // Solo los que tienen ubicación

      const dist = haversineKm(
        userCoords.lat, userCoords.lng,
        f.location.latitude, f.location.longitude
      );

      if (dist <= RADIUS_KM) {
        nearby.push({ ...f, distance: dist });
      }
    });

    // Ordenar por distancia
    nearby.sort((a, b) => a.distance - b.distance);

    if (nearby.length === 0) {
      contentEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🗺️</div>
          <h3>Sin peleadores cercanos</h3>
          <p>No hay peleadores registrados en un radio de ${RADIUS_KM} km.<br/>
          Sigue verificando o amplía el área.</p>
          <button class="btn btn-outline mt-2" onclick="findNearbyFighters()">🔄 Reintentar</button>
        </div>`;
      return;
    }

    contentEl.innerHTML = `
      <p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:1rem;">
        ${nearby.length} peleador(es) encontrados en un radio de ${RADIUS_KM} km
      </p>
      <div class="fighters-grid">
        ${nearby.map(f => {
          const photo = f.photoURL || `https://api.dicebear.com/7.x/adventurer-neutral/svg?seed=${encodeURIComponent(f.apodo)}`;
          const distStr = f.distance < 1 ? `${Math.round(f.distance * 1000)} m` : `${f.distance.toFixed(1)} km`;
          return `
            <div class="fighter-card" onclick="viewFighterProfile('${escHtml(f.uid)}')">
              <img src="${escHtml(photo)}" alt="${escHtml(f.apodo)}" class="fighter-card-avatar" loading="lazy"/>
              <div class="fighter-card-apodo">"${escHtml(f.apodo)}"</div>
              <div class="fighter-card-name">${escHtml(f.nombre)}</div>
              <div class="fighter-card-score">${f.score || 1000}</div>
              <div class="fighter-card-location">🌍 ${escHtml(f.pais)} · ${escHtml(f.ciudad)}</div>
              <div class="fighter-card-distance">📍 ${distStr}</div>
              <button class="btn btn-primary btn-sm btn-full"
                onclick="event.stopPropagation(); sendChallenge('${escHtml(f.uid)}','${escHtml(f.apodo)}','${f.score||1000}')">
                ⚔️ Desafiar
              </button>
            </div>`;
        }).join('')}
      </div>`;

  } catch (err) {
    console.error(err);
    contentEl.innerHTML = `<div class="empty-state"><p class="text-danger">Error: ${err.message}</p></div>`;
  }
};

// ─── VER PERFIL DE PELEADOR ───────────────────────────────────────────────────
window.viewFighterProfile = function(uid) {
  if (uid === currentUser?.uid) {
    window.location.href = 'profile.html';
  } else {
    window.location.href = `profile.html?uid=${uid}`;
  }
};

// ─── ENVIAR DESAFÍO ──────────────────────────────────────────────────────────
window.sendChallenge = async function(toUid, toApodo, toScore) {
  if (!currentUser || !currentUserData) return;
  if (!currentUserData.profileComplete) {
    showToast('warning', 'Perfil incompleto', 'Completa tu perfil antes de desafiar.'); return;
  }

  try {
    // Verificar que no exista un desafío pendiente entre estos dos usuarios
    const existingQ = query(
      collection(db, 'challenges'),
      where('fromUid', '==', currentUser.uid),
      where('toUid', '==', toUid),
      where('status', '==', 'pending')
    );
    const existSnap = await getDocs(existingQ);
    if (!existSnap.empty) {
      showToast('info', 'Ya enviado', `Ya tienes un desafío pendiente con ${toApodo}.`); return;
    }

    await addDoc(collection(db, 'challenges'), {
      fromUid: currentUser.uid,
      fromApodo: currentUserData.apodo,
      fromScore: currentUserData.score || 1000,
      toUid,
      toApodo,
      toScore: toScore || 1000,
      status: 'pending',
      timestamp: serverTimestamp()
    });

    showToast('success', '¡Desafío enviado!', `Has desafiado a "${toApodo}". Espera su respuesta.`);
  } catch (err) {
    showToast('error', 'Error', 'No se pudo enviar el desafío: ' + err.message);
  }
};

// ─── ESCUCHAR DESAFÍOS EN TIEMPO REAL ────────────────────────────────────────
function listenForChallenges() {
  if (!currentUser) return;

  const q = query(
    collection(db, 'challenges'),
    where('toUid', '==', currentUser.uid),
    where('status', '==', 'pending')
  );

  challengeListener = onSnapshot(q, (snap) => {
    const count = snap.docs.length;

    // Actualizar badges
    const badge = document.getElementById('sidebarNotifBadge');
    const navBadge = document.getElementById('navNotifBadge');
    const notifCount = document.getElementById('notifCount');

    if (count > 0) {
      badge.textContent = count;
      badge.classList.remove('hidden');
      if (navBadge) { navBadge.classList.remove('hidden'); notifCount.textContent = count; }
    } else {
      badge.classList.add('hidden');
      if (navBadge) navBadge.classList.add('hidden');
    }

    // Si hay un nuevo desafío, mostrar modal automáticamente
    snap.docChanges().forEach(change => {
      if (change.type === 'added') {
        const challenge = { id: change.doc.id, ...change.doc.data() };
        // Solo mostrar modal si el modal no está ya abierto
        if (!document.getElementById('challengeModal').classList.contains('open')) {
          showChallengeModal(challenge);
        }
      }
    });
  });
}

// ─── MODAL DE DESAFÍO ─────────────────────────────────────────────────────────
function showChallengeModal(challenge) {
  activeChallengeId = challenge.id;
  activeChallengeData = challenge;

  document.getElementById('challengerName').textContent = `"${challenge.fromApodo}"`;
  document.getElementById('challengerScore').textContent = `Score: ${challenge.fromScore || '???'} pts`;
  document.getElementById('challengeDesc').textContent =
    `¿Aceptas pelear contra "${challenge.fromApodo}"?`;

  document.getElementById('challengeModal').classList.add('open');
}

window.closeChallengeModal = function() {
  document.getElementById('challengeModal').classList.remove('open');
  activeChallengeId = null;
  activeChallengeData = null;
};

window.rejectChallenge = async function() {
  if (!activeChallengeId) return;
  try {
    await updateDoc(doc(db, 'challenges', activeChallengeId), {
      status: 'rejected'
    });
    showToast('info', 'Desafío rechazado', 'Has rechazado el desafío.');
    closeChallengeModal();
  } catch (err) {
    showToast('error', 'Error', err.message);
  }
};

window.acceptChallenge = async function() {
  if (!activeChallengeId || !activeChallengeData) return;
  try {
    await updateDoc(doc(db, 'challenges', activeChallengeId), { status: 'accepted' });

    // Preparar datos para el modal de resultado
    pendingFightData = {
      challengeId: activeChallengeId,
      opponentUid: activeChallengeData.fromUid,
      opponentApodo: activeChallengeData.fromApodo,
      opponentScore: activeChallengeData.fromScore || 1000
    };

    closeChallengeModal();

    // Mostrar modal para elegir resultado
    document.getElementById('fightDesc').textContent =
      `Pelea vs. "${pendingFightData.opponentApodo}" – ¿Cuál fue el resultado?`;
    document.getElementById('fightModal').classList.add('open');

  } catch (err) {
    showToast('error', 'Error', err.message);
  }
};

window.closeFightModal = function() {
  document.getElementById('fightModal').classList.remove('open');
  pendingFightData = null;
};

window.closeOpponentModal = function() {
  document.getElementById('opponentModal').classList.remove('open');
};

// ─── REGISTRAR RESULTADO DE PELEA ─────────────────────────────────────────────
window.recordFight = async function(resultado) {
  if (!pendingFightData || !currentUser || !currentUserData) return;

  const btn_sel = document.querySelector(`#fightModal .btn-${resultado === 'win' ? 'success' : resultado === 'loss' ? 'danger' : 'secondary'}`);
  if (btn_sel) { btn_sel.disabled = true; btn_sel.innerHTML = '<span class="spinner-sm"></span>'; }

  try {
    const myScore = currentUserData.score || 1000;
    const opponentScore = pendingFightData.opponentScore || 1000;

    // ─── Cálculo ELO ────────────────────────────────────────────────────────
    // Probabilidad esperada de ganar
    const Ea = 1 / (1 + Math.pow(10, (opponentScore - myScore) / 400));
    const K = 32; // Factor K estándar

    let myNewScore, oppNewScore;
    let Sa; // 1 = win, 0.5 = draw, 0 = loss (para mi)

    if (resultado === 'win') Sa = 1;
    else if (resultado === 'draw') Sa = 0.5;
    else Sa = 0;

    myNewScore  = Math.round(myScore + K * (Sa - Ea));
    oppNewScore = Math.round(opponentScore + K * ((1 - Sa) - (1 - Ea)));

    // Mínimo 100 puntos
    myNewScore  = Math.max(100, myNewScore);
    oppNewScore = Math.max(100, oppNewScore);

    const now = new Date();

    // Registro de pelea para MI perfil
    const myFightRecord = {
      opponentUid: pendingFightData.opponentUid,
      opponentApodo: pendingFightData.opponentApodo,
      fecha: now.toISOString(),
      resultado,
      miScoreAntes: myScore,
      miScoreDespues: myNewScore
    };

    // Registro de pelea para el OPONENTE
    const oppResultado = resultado === 'win' ? 'loss' : resultado === 'loss' ? 'win' : 'draw';
    const oppFightRecord = {
      opponentUid: currentUser.uid,
      opponentApodo: currentUserData.apodo,
      fecha: now.toISOString(),
      resultado: oppResultado,
      miScoreAntes: opponentScore,
      miScoreDespues: oppNewScore
    };

    // Actualizar mi perfil
    const myUpdates = {
      score: myNewScore,
      fights: arrayUnion(myFightRecord),
      updatedAt: serverTimestamp()
    };
    if (resultado === 'win') myUpdates.wins = (currentUserData.wins || 0) + 1;
    else if (resultado === 'loss') myUpdates.losses = (currentUserData.losses || 0) + 1;
    else myUpdates.draws = (currentUserData.draws || 0) + 1;

    await updateDoc(doc(db, 'users', currentUser.uid), myUpdates);

    // Actualizar oponente
    const oppSnap = await getDoc(doc(db, 'users', pendingFightData.opponentUid));
    if (oppSnap.exists()) {
      const oppData = oppSnap.data();
      const oppUpdates = {
        score: oppNewScore,
        fights: arrayUnion(oppFightRecord),
        updatedAt: serverTimestamp()
      };
      if (oppResultado === 'win') oppUpdates.wins = (oppData.wins || 0) + 1;
      else if (oppResultado === 'loss') oppUpdates.losses = (oppData.losses || 0) + 1;
      else oppUpdates.draws = (oppData.draws || 0) + 1;
      await updateDoc(doc(db, 'users', pendingFightData.opponentUid), oppUpdates);
    }

    // Eliminar el challenge
    if (pendingFightData.challengeId) {
      await deleteDoc(doc(db, 'challenges', pendingFightData.challengeId));
    }

    // Actualizar datos locales
    currentUserData = { ...currentUserData, ...myUpdates };
    renderSidebar(currentUserData);

    closeFightModal();

    // Toast con resultado
    const diff = myNewScore - myScore;
    const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
    const msgMap = {
      win: `🏆 ¡Ganaste! Score: ${myScore} → ${myNewScore} (${diffStr})`,
      loss: `💀 Perdiste. Score: ${myScore} → ${myNewScore} (${diffStr})`,
      draw: `🤝 Empate. Score: ${myScore} → ${myNewScore} (${diffStr})`
    };
    showToast(resultado === 'win' ? 'success' : resultado === 'loss' ? 'error' : 'warning',
      'Pelea registrada', msgMap[resultado]);

    loadRanking(); // Refrescar ranking

  } catch (err) {
    console.error('Error registrando pelea:', err);
    showToast('error', 'Error', 'No se pudo registrar la pelea: ' + err.message);
    if (btn_sel) { btn_sel.disabled = false; btn_sel.textContent = '...'; }
  }
};

// ─── MIS PELEAS ───────────────────────────────────────────────────────────────
window.loadMyFights = async function() {
  const el = document.getElementById('fightsContent');
  el.innerHTML = `<div style="text-align:center;padding:2rem;"><div class="spinner-sm"></div></div>`;

  try {
    const snap = await getDoc(doc(db, 'users', currentUser.uid));
    const fights = snap.data()?.fights || [];

    if (fights.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">🥊</div><h3>Sin peleas aún</h3><p>Desafía a peleadores cercanos para empezar.</p></div>`;
      return;
    }

    const sorted = [...fights].sort((a, b) => {
      return new Date(b.fecha || 0) - new Date(a.fecha || 0);
    });

    el.innerHTML = `<div class="fight-list">
      ${sorted.map(f => {
        const diff = (f.miScoreDespues || 0) - (f.miScoreAntes || 0);
        const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
        const diffCls = diff > 0 ? 'positive' : diff < 0 ? 'negative' : '';
        const fecha = f.fecha ? new Date(f.fecha).toLocaleDateString('es', {day:'2-digit',month:'short',year:'numeric'}) : '—';
        const resLabel = { win:'🏆 WIN', loss:'💀 LOSS', draw:'🤝 DRAW' }[f.resultado] || f.resultado;
        return `
          <div class="fight-item">
            <div class="fight-result ${f.resultado}">${resLabel}</div>
            <div class="fight-opponent">
              <div class="apodo">vs. "${escHtml(f.opponentApodo)}"</div>
              <div class="date">📅 ${fecha}</div>
            </div>
            <div>
              <div style="font-size:0.8rem;color:var(--text-muted);">${f.miScoreAntes} → ${f.miScoreDespues}</div>
              <div class="fight-score-change ${diffCls}">${diffStr} pts</div>
            </div>
          </div>`;
      }).join('')}
    </div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p class="text-danger">Error: ${err.message}</p></div>`;
  }
};

// ─── NOTIFICACIONES / DESAFÍOS PENDIENTES ────────────────────────────────────
window.loadNotifications = async function() {
  const el = document.getElementById('notificationsContent');
  el.innerHTML = `<div style="text-align:center;padding:2rem;"><div class="spinner-sm"></div></div>`;

  try {
    const q = query(
      collection(db, 'challenges'),
      where('toUid', '==', currentUser.uid),
      orderBy('timestamp', 'desc')
    );
    const snap = await getDocs(q);

    if (snap.empty) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">🔔</div><h3>Sin desafíos</h3><p>Aquí aparecerán los desafíos que recibas.</p></div>`;
      return;
    }

    const statusLabel = { pending:'⏳ Pendiente', accepted:'✅ Aceptado', rejected:'❌ Rechazado' };
    const statusColor = { pending:'var(--warning)', accepted:'var(--success)', rejected:'var(--danger)' };

    el.innerHTML = `<div class="notification-list">
      ${snap.docs.map(d => {
        const c = d.data();
        const ts = c.timestamp?.toDate ? c.timestamp.toDate() : null;
        const timeStr = ts ? ts.toLocaleDateString('es', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
        return `
          <div class="notification-item ${c.status === 'pending' ? 'new' : ''}">
            <div class="notification-icon">⚔️</div>
            <div class="notification-content">
              <div class="notification-title">"${escHtml(c.fromApodo)}" te desafió</div>
              <div class="notification-time">📅 ${timeStr}</div>
            </div>
            <div style="display:flex;align-items:center;gap:0.75rem;">
              <span style="font-size:0.8rem;font-family:var(--font-heading);color:${statusColor[c.status]||'var(--text-muted)'};">
                ${statusLabel[c.status] || c.status}
              </span>
              ${c.status === 'pending' ? `
                <button class="btn btn-success btn-sm" onclick="acceptFromNotif('${d.id}', '${escHtml(c.fromUid)}', '${escHtml(c.fromApodo)}', ${c.fromScore||1000})">Aceptar</button>
                <button class="btn btn-danger btn-sm" onclick="rejectFromNotif('${d.id}')">Rechazar</button>
              ` : ''}
            </div>
          </div>`;
      }).join('')}
    </div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty-state"><p class="text-danger">Error: ${err.message}</p></div>`;
  }
};

window.acceptFromNotif = async function(challengeId, fromUid, fromApodo, fromScore) {
  await updateDoc(doc(db, 'challenges', challengeId), { status: 'accepted' });
  pendingFightData = { challengeId, opponentUid: fromUid, opponentApodo: fromApodo, opponentScore: fromScore };
  document.getElementById('fightDesc').textContent = `Pelea vs. "${fromApodo}" – ¿Cuál fue el resultado?`;
  document.getElementById('fightModal').classList.add('open');
};

window.rejectFromNotif = async function(challengeId) {
  await updateDoc(doc(db, 'challenges', challengeId), { status: 'rejected' });
  showToast('info', 'Desafío rechazado', 'Has rechazado el desafío.');
  loadNotifications();
};

window.markAllRead = function() {
  showToast('info', 'Marcado', 'Funcionalidad de marca como leído próximamente.');
};

// ─── SISTEMA DE NIVELES ───────────────────────────────────────────────────────
function getLevel(score) {
  if (score >= 2000) return { label: '🔥 LEYENDA', cls: 'level-legend' };
  if (score >= 1500) return { label: '👑 CAMPEÓN', cls: 'level-champion' };
  if (score >= 1250) return { label: '⚡ BRAWLER', cls: 'level-brawler' };
  if (score >= 1100) return { label: '🥋 FIGHTER', cls: 'level-fighter' };
  return { label: '🆕 ROOKIE', cls: 'level-rookie' };
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function escHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.showToast = function(type, title, message, duration = 4500) {
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>`;
  document.getElementById('toastContainer').appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
};
