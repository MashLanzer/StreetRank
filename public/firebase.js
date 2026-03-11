/**
 * firebase.js
 * Inicialización de Firebase y exportación de servicios.
 *
 * ── ESTRATEGIA DE ALMACENAMIENTO DE IMÁGENES ────────────────────────────────
 * Las fotos de perfil NO se guardan en Firebase Storage (ahorra cuota).
 * En su lugar se suben a ImgBB (servicio gratuito de hosting de imágenes).
 * Solo los metadatos (URL de imagen) se almacenan en Firestore.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ── CLAVE IMGBB ─────────────────────────────────────────────────────────────
 * Obtén tu clave gratuita en: https://api.imgbb.com/
 * Pégala en IMGBB_API_KEY más abajo.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ─── Configuración Firebase ───────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyAcJiDXp7woEbXS8Y2Bs0y5tWblttIbC-M",
  authDomain:        "streetrank-96af0.firebaseapp.com",
  projectId:         "streetrank-96af0",
  messagingSenderId: "740449956199",
  appId:             "1:740449956199:web:680cbe91df6ae4294f3fc2",
  measurementId:     "G-W7THD6ZQ1Q"
};

// ─── Clave de la API de ImgBB ─────────────────────────────────────────────────
// 1. Regístrate gratis en https://imgbb.com/ → API → genera tu key
// 2. Pega aquí tu clave:
export const IMGBB_API_KEY = "17aa95de182f3b04241242386a962ee8";
// Ejemplo: export const IMGBB_API_KEY = "abc123def456...";
// ─────────────────────────────────────────────────────────────────────────────

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Persistencia offline con la API moderna (reemplaza el deprecado enableIndexedDbPersistence)
export const db = initializeFirestore(app, {
  cache: persistentLocalCache({
    tabManager: persistentMultipleTabManager() // soporta varias pestañas sin errores
  })
});
// NOTA: 'storage' no se exporta. Usamos ImgBB en su lugar.

// ─── Función reutilizable: subir imagen a ImgBB ───────────────────────────────
/**
 * Sube un File a ImgBB y devuelve { url, deleteUrl }.
 * No usa Firebase Storage → 0 bytes consumidos en Firebase.
 *
 * @param {File}     file              - Objeto File del <input type="file">
 * @param {Function} [onProgress]      - Callback opcional (0-100) para barra de progreso
 * @returns {Promise<{url:string, deleteUrl:string}>}
 */
export async function uploadToImgBB(file, onProgress) {
  return new Promise((resolve, reject) => {
    // Convertir a Base64 con FileReader
    const reader = new FileReader();

    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));

    reader.onload = async (e) => {
      try {
        // Base64 sin el prefijo "data:image/xxx;base64,"
        const base64 = e.target.result.split(",")[1];

        if (onProgress) onProgress(20); // Lectura completada

        const formData = new FormData();
        formData.append("image", base64);
        formData.append("key", IMGBB_API_KEY);

        if (onProgress) onProgress(40); // Iniciando fetch

        // Simular progreso intermedio mientras se sube
        let progressInterval = null;
        if (onProgress) {
          let fakeProgress = 40;
          progressInterval = setInterval(() => {
            fakeProgress = Math.min(fakeProgress + 5, 85);
            onProgress(fakeProgress);
          }, 300);
        }

        const response = await fetch("https://api.imgbb.com/1/upload", {
          method: "POST",
          body: formData
        });

        if (progressInterval) clearInterval(progressInterval);
        if (onProgress) onProgress(90);

        if (!response.ok) {
          throw new Error(`ImgBB respondió con status ${response.status}`);
        }

        const json = await response.json();

        if (!json.success) {
          throw new Error(json.error?.message || "Error desconocido de ImgBB.");
        }

        if (onProgress) onProgress(100);

        resolve({
          url:       json.data.url,          // URL pública de la imagen
          deleteUrl: json.data.delete_url    // URL para eliminarla después
        });

      } catch (err) {
        reject(err);
      }
    };

    reader.readAsDataURL(file);
  });
}

export default app;
