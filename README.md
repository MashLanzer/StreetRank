# StreetRank ⚔️
### La red social de ranking de peleas callejeras

---

## 🚀 Puesta en marcha rápida

### 1. Requisitos de Firebase / ImgBB

| Servicio | Uso |
|---|---|
| **Firebase Authentication** | Login con email/password |
| **Firebase Firestore** | Base de datos (perfiles, peleas, desafíos) |
| **ImgBB** | Hosting de fotos de perfil – **sin consumir Firebase Storage** |

> ⚠️ **Firebase Storage no es necesario.** Las imágenes se suben a ImgBB gratis y solo se guarda la URL en Firestore.

### 2. Configurar Firebase Console

Antes de abrir el proyecto **debes** completar estos pasos:

#### a) Crear el proyecto
1. Ve a https://console.firebase.google.com
2. Crea un nuevo proyecto o usa el existente `streetrank-96af0`

#### b) Habilitar Authentication
- Firebase Console → Authentication → Sign-in method
- Activa **Email/Contraseña**

#### c) Habilitar Firestore
- Firebase Console → Firestore Database → Crear base de datos
- Empieza en **modo de prueba** o configura las reglas:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Usuarios: leer libre, escribir solo el propio
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == userId;
    }

    // Desafíos: leer/crear si logueado, actualizar si eres el destinatario
    match /challenges/{challengeId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null;
      allow update: if request.auth != null &&
        (resource.data.toUid == request.auth.uid ||
         resource.data.fromUid == request.auth.uid);
      allow delete: if request.auth != null;
    }
  }
}
```

#### d) Obtener clave de ImgBB (para fotos de perfil)
1. Regístrate gratis en **https://imgbb.com/**
2. Ve a tu cuenta → **API** → genera una clave
3. Abre `firebase.js` y pega tu clave en:
   ```js
   export const IMGBB_API_KEY = "TU_CLAVE_IMGBB_AQUI";
   ```

> Las fotos se alojan en ImgBB. Firestore solo guarda la URL — **0 bytes** consumidos en Firebase Storage.

#### e) Índices Firestore requeridos
Necesitas crear estos índices en Firestore Console → Índices:

| Colección | Campo 1 | Campo 2 | Tipo |
|---|---|---|---|
| `challenges` | `toUid` ASC | `timestamp` DESC | Compuesto |
| `challenges` | `fromUid` ASC | `toUid` ASC | Compuesto |

> Los índices simples (solo `score DESC`, solo `toUid`) se crean automáticamente.

---

### 3. Abrir el proyecto

**Importante:** Al usar `import` de ES Modules, necesitas servir el proyecto desde un servidor web local. NO puedes abrir `index.html` directamente con `file://`.

#### Opción A – Live Server (Recomendado en VS Code)
1. Instala la extensión **Live Server** en VS Code
2. Click derecho en `index.html` → "Open with Live Server"

#### Opción B – Python
```bash
cd c:\Proyectos\StreetRank
python -m http.server 3000
# Abre http://localhost:3000
```

#### Opción C – Node.js (npx serve)
```bash
cd c:\Proyectos\StreetRank
npx serve .
```

---

## 📁 Estructura de archivos

```
StreetRank/
├── index.html          ← Login + Registro
├── profile-setup.html  ← Creación de perfil (3 pasos)
├── dashboard.html      ← Panel principal
├── profile.html        ← Perfil propio y ajeno
├── style.css           ← Estilos globales (tema oscuro/rojo)
├── firebase.js         ← Inicialización Firebase
├── app.js              ← Lógica del dashboard
└── README.md
```

---

## 🗄️ Estructura de Firestore

### Colección `users` (documento por `uid`)
```json
{
  "uid": "abc123",
  "email": "user@email.com",
  "nombre": "Carlos García",
  "apodo": "El Toro",
  "pais": "México",
  "ciudad": "Guadalajara",
  "edad": 25,
  "peso": 78.5,
  "altura": 178,
  "manoHabil": "derecha",
  "descripcion": "Vengo de las calles...",
  "photoURL": "https://i.ibb.co/...",
  "photoDeleteUrl": "https://ibb.co/delete/...",
  "score": 1000,
  "wins": 0,
  "losses": 0,
  "draws": 0,
  "fights": [
    {
      "opponentUid": "xyz789",
      "opponentApodo": "La Cobra",
      "fecha": "2024-01-15T...",
      "resultado": "win",
      "miScoreAntes": 1000,
      "miScoreDespues": 1028
    }
  ],
  "location": { "latitude": 20.659, "longitude": -103.349 },
  "lastLocationUpdate": "Timestamp",
  "profileComplete": true,
  "createdAt": "Timestamp",
  "updatedAt": "Timestamp"
}
```

> `photoURL` apunta a ImgBB. `photoDeleteUrl` permite borrar la imagen de ImgBB si el usuario elimina su cuenta.

### Colección `challenges` (documento auto-id)
```json
{
  "fromUid": "abc123",
  "fromApodo": "El Toro",
  "fromScore": 1028,
  "toUid": "xyz789",
  "toApodo": "La Cobra",
  "toScore": 1050,
  "status": "pending",
  "timestamp": "Timestamp"
}
```
`status` puede ser: `"pending"` | `"accepted"` | `"rejected"`

---

## ⚔️ Sistema ELO

El juego usa el sistema ELO estándar con K=32:

```
Score nuevo = Score actual + 32 × (Resultado - Probabilidad esperada)
Probabilidad esperada = 1 / (1 + 10^((ScoreRival - ScorePropio) / 400))
```

- Mínimo de puntos: **100**
- Score inicial: **1000**

### Niveles
| Score | Nivel |
|---|---|
| < 1100 | 🆕 ROOKIE |
| 1100–1249 | 🥋 FIGHTER |
| 1250–1499 | ⚡ BRAWLER |
| 1500–1999 | 👑 CAMPEÓN |
| 2000+ | 🔥 LEYENDA |

---

## 🗺️ Sistema de proximidad (Haversine)

La función calcula la distancia en km entre dos coordenadas geográficas:

```js
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
```

Radio de búsqueda: **50 km** (configurable en `app.js` → `RADIUS_KM`)

---

## ⚠️ Limitaciones conocidas

1. **Búsqueda de cercanos**: Actualmente descarga hasta 200 usuarios y filtra en cliente. Para producción real, usa Geohash o una Cloud Function.
2. **Resultado de pelea**: El resultado lo reporta el que acepta el desafío. En producción necesitarías consenso/árbitro.
3. **Reglas Firestore**: Las reglas de prueba tienen 30 días. Configura las reglas permanentes antes de lanzar.

---

*StreetRank – El ring de la calle. No promovemos violencia real.*
