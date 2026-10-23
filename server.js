const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { getAuth } = require("firebase-admin/auth");
const fs = require("fs");
const http = require("http");
const path = require("path");

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  console.log("Firebase-Schlüssel aus Render geladen.");
} else {
  const keyFile = fs.readdirSync(__dirname).find(
    name => name.includes("firebase-adminsdk") && name.endsWith(".json")
  );

  if (!keyFile) {
    console.error("Firebase-Servicekonto-Datei wurde nicht gefunden.");
    process.exit(1);
  }

  serviceAccount = require(path.join(__dirname, keyFile));
  console.log("Firebase-Schlüssel aus lokaler Datei geladen.");
}

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
const messaging = getMessaging();
const adminAuth = getAuth();

const startedAt = Date.now();

console.log("FamilienChat Benachrichtigungs-Server startet...");


/* =====================================================
   FCM TOKENS
===================================================== */

async function getTokens(userId) {
  const snapshot = await db
    .collection("users")
    .doc(userId)
    .collection("tokens")
    .get();

  return snapshot.docs
    .map(doc => doc.data().token)
    .filter(Boolean);
}


/* =====================================================
   NORMALE PUSH-BENACHRICHTIGUNG
===================================================== */

async function sendPush(userId, title, body) {
  const tokens = await getTokens(userId);

  if (tokens.length === 0) {
    console.log("Kein Benachrichtigungs-Token für:", userId);
    return;
  }

  for (const token of tokens) {
    try {
      await messaging.send({
        token,

        notification: {
          title,
          body
        },

        webpush: {
          notification: {
            title,
            body
          },

          fcmOptions: {
            link: "https://familienchat-5fc00.web.app"
          }
        }
      });

      console.log("🔔 Benachrichtigung gesendet an:", userId);

    } catch (error) {
      console.error("Push-Fehler:", error.message);
    }
  }
}


/* =====================================================
   ANRUF-PUSH
===================================================== */

async function sendCallPush(userId, callerName, callId) {
  const tokens = await getTokens(userId);

  if (tokens.length === 0) {
    console.log("Kein Benachrichtigungs-Token für Anruf:", userId);
    return;
  }

  for (const token of tokens) {
    try {
      await messaging.send({
        token,

        notification: {
          title: "📞 Eingehender Anruf",
          body: (callerName || "FamilienChat") + " ruft dich an"
        },

        data: {
          type: "call",
          callId: String(callId),
          callerName: String(callerName || "FamilienChat")
        },

        webpush: {
          notification: {
            title: "📞 Eingehender Anruf",
            body: (callerName || "FamilienChat") + " ruft dich an",

            requireInteraction: true,

            tag: "familienchat-call-" + callId,

            data: {
              type: "call",
              callId: String(callId)
            }
          },

          fcmOptions: {
            link: "https://familienchat-5fc00.web.app"
          }
        }
      });

      console.log(
        "📞 Anruf-Benachrichtigung gesendet an:",
        userId,
        "von:",
        callerName
      );

    } catch (error) {
      console.error(
        "Anruf-Push-Fehler:",
        error.message
      );
    }
  }
}


/* =====================================================
   PRIVATE NACHRICHTEN
===================================================== */

db.collectionGroup("messages").onSnapshot(
  snapshot => {

    snapshot.docChanges().forEach(async change => {

      if (change.type !== "added") return;

      const data = change.doc.data();

      if (!data.recipientId) return;

      const messageTime = data.time?.toMillis?.();

      if (!messageTime || messageTime < startedAt) return;

      let text = data.text;

      if (!text) {

        if (data.mediaType === "image") {
          text = "📷 Foto";
        }

        else if (data.mediaType === "video") {
          text = "🎥 Video";
        }

        else {
          text = "📎 Datei";
        }
      }

      await sendPush(
        data.recipientId,
        data.name || "FamilienChat",
        text
      );
    });
  },

  error => {
    console.error(
      "Private Chat Listener Fehler:",
      error.message
    );
  }
);


/* =====================================================
   TELEFONANRUFE
===================================================== */

db.collection("calls").onSnapshot(
  snapshot => {

    snapshot.docChanges().forEach(async change => {

      if (
        change.type !== "added" &&
        change.type !== "modified"
      ) {
        return;
      }

      const data = change.doc.data();

      if (!data.calleeId) return;

      if (data.status !== "calling") return;

      /*
        Verhindert, dass derselbe Anruf bei jeder
        Firestore-Änderung erneut eine Push-Nachricht erzeugt.
      */

      if (data.pushSent === true) return;

      try {

        await change.doc.ref.update({
          pushSent: true
        });

        await sendCallPush(
          data.calleeId,
          data.callerName || "FamilienChat",
          change.doc.id
        );

      } catch (error) {

        console.error(
          "Anruf Listener Fehler:",
          error.message
        );
      }
    });
  },

  error => {
    console.error(
      "Calls Listener Fehler:",
      error.message
    );
  }
);


/* =====================================================
   CORS
===================================================== */

function setCorsHeaders(req, res) {

  const allowedOrigins = new Set([
    "https://familienchat-5fc00.web.app",
    "https://familienchat-5fc00.firebaseapp.com"
  ]);

  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  res.setHeader("Vary", "Origin");

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );
}


/* =====================================================
   FIREBASE BENUTZER PRÜFEN
===================================================== */

async function verifyFirebaseUser(req) {

  const authHeader =
    req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("Kein Firebase-Token.");
  }

  return await adminAuth.verifyIdToken(
    authHeader.substring(7)
  );
}


/* =====================================================
   WEB SERVER
===================================================== */

const PORT =
  process.env.PORT || 3000;


http.createServer(
  async (req, res) => {

    setCorsHeaders(req, res);


    /* OPTIONS */

    if (req.method === "OPTIONS") {

      res.writeHead(204);

      res.end();

      return;
    }


    /* TURN CONFIG */

    if (
      req.method === "GET" &&
      req.url === "/turn-config"
    ) {

      try {

        await verifyFirebaseUser(req);

        const username =
          process.env.METERED_USERNAME;

        const password =
          process.env.METERED_PASSWORD;


        if (!username || !password) {

          throw new Error(
            "Metered TURN-Zugangsdaten fehlen."
          );
        }


        const iceServers = [

          {
            urls:
              "stun:stun.relay.metered.ca:80"
          },

          {
            urls:
              "turn:global.relay.metered.ca:80",

            username,

            credential: password
          },

          {
            urls:
              "turn:global.relay.metered.ca:80?transport=tcp",

            username,

            credential: password
          },

          {
            urls:
              "turn:global.relay.metered.ca:443",

            username,

            credential: password
          },

          {
            urls:
              "turns:global.relay.metered.ca:443?transport=tcp",

            username,

            credential: password
          }
        ];


        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json; charset=utf-8",

            "Cache-Control":
              "no-store"
          }
        );


        res.end(
          JSON.stringify({
            iceServers
          })
        );

        return;

      } catch (error) {

        console.error(
          "TURN-Konfiguration Fehler:",
          error.message
        );


        res.writeHead(
          401,
          {
            "Content-Type":
              "application/json; charset=utf-8",

            "Cache-Control":
              "no-store"
          }
        );


        res.end(
          JSON.stringify({
            error:
              "Nicht autorisiert."
          })
        );

        return;
      }
    }


    /* STARTSEITE */

    res.writeHead(
      200,
      {
        "Content-Type":
          "text/plain; charset=utf-8"
      }
    );


    res.end(
      "FamilienChat Benachrichtigungs-Server läuft."
    );
  }
)

.listen(
  PORT,
  () => {
    console.log(
      "Server läuft auf Port " + PORT
    );
  }
);