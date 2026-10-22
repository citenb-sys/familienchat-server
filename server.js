const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const fs = require("fs");
const http = require("http");
const path = require("path");
// Firebase-Servicekonto laden:
// Auf Render aus der Umgebungsvariable,
// auf dem PC weiterhin aus der lokalen JSON-Datei.
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
// Firebase Admin starten
initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
const messaging = getMessaging();

const startedAt = Date.now();

console.log("FamilienChat Benachrichtigungs-Server startet...");

// Tokens eines Benutzers laden
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

// Push-Nachricht senden
async function sendPush(userId, title, body) {
  const tokens = await getTokens(userId);

  if (tokens.length === 0) {
    console.log("Kein Benachrichtigungs-Token für:", userId);
    return;
  }

  for (const token of tokens) {
    try {
      await messaging.send({
        token: token,

        notification: {
          title: title,
          body: body
        },

        webpush: {
          notification: {
            title: title,
            body: body
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

// Private Nachrichten beobachten
db.collectionGroup("messages").onSnapshot(
  snapshot => {

    snapshot.docChanges().forEach(async change => {

      if (change.type !== "added") return;

      const data = change.doc.data();

      // Nur private Nachrichten
      if (!data.recipientId) return;

      const messageTime = data.time?.toMillis?.();

      // Alte Nachrichten beim Start nicht erneut melden
      if (!messageTime || messageTime < startedAt) return;

      let text = data.text;

      if (!text) {
        if (data.mediaType === "image") {
          text = "📷 Foto";
        } else if (data.mediaType === "video") {
          text = "🎥 Video";
        } else {
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

// Webserver für Render
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end(
    "FamilienChat Benachrichtigungs-Server läuft."
  );

}).listen(PORT, () => {

  console.log("Server läuft auf Port " + PORT);

});