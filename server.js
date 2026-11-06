const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { getAuth } = require("firebase-admin/auth");
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
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
    "GET, POST, OPTIONS"
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
   FAMILIENCHAT – SICHERE EINLADUNGEN
===================================================== */

function inviteResponse(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}


/* JSON-DATEN LESEN */

async function readInviteJson(req) {
  let raw = "";

  for await (const chunk of req) {
    raw += chunk;

    if (raw.length > 10000) {
      throw new Error("Anfrage zu groß");
    }
  }

  return JSON.parse(raw || "{}");
}


/* EINLADUNG ERSTELLEN */

async function createInvite(req, res) {

  const caller = await verifyFirebaseUser(req);

  const inviterRef = db
    .collection("users")
    .doc(caller.uid);

  const inviter = await inviterRef.get();

  if (!inviter.exists) {
    return inviteResponse(res, 403, {
      error: "Benutzer nicht gefunden."
    });
  }

  const inviterData = inviter.data();

  const role = inviterData.role;

  if (role !== "admin" && role !== "familie") {
    return inviteResponse(res, 403, {
      error: "Nur Familienmitglieder dürfen einladen."
    });
  }

  const body = await readInviteJson(req);

  const type = body.type;

  if (type !== "freund") {
    return inviteResponse(res, 400, {
      error: "Ungültige Einladungsart."
    });
  }

  /* Freunde dürfen nur bestimmte Familienmitglieder einladen */

  /* Sicheren Einladungscode erstellen */

  const token = crypto
    .randomBytes(32)
    .toString("hex");

  const hash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const now = Date.now();

  /* Einladung läuft nach sieben Tagen ab */

  await db.collection("invites").doc(hash).set({

    type: type,

    inviterId: caller.uid,

    createdAt: now,

    expiresAt: now + 7 * 24 * 60 * 60 * 1000,

    usedBy: null

  });
return inviteResponse(res, 200, {

  ok: true,

  token: token,

  type: type,

  expiresInDays: 7,

  inviterName: inviterData.name || "Familienmitglied",

  inviterPhoto: inviterData.profilePhotoUrl || ""

});
}


/* EINLADUNG ANNEHMEN */
async function previewInvite(req, res) {

  const body = await readInviteJson(req);
  const token = body.token;

  if (
    typeof token !== "string" ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    return inviteResponse(res, 400, {
      error: "Ungültiger Einladungslink."
    });
  }

  const hash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const invite = await db
    .collection("invites")
    .doc(hash)
    .get();

  if (!invite.exists) {
    return inviteResponse(res, 404, {
      error: "Einladung nicht gefunden."
    });
  }

  const data = invite.data();

  if (data.usedBy || data.expiresAt < Date.now()) {
    return inviteResponse(res, 400, {
      error: "Einladung abgelaufen oder bereits verwendet."
    });
  }

  if (data.type !== "freund") {
    return inviteResponse(res, 403, {
      error: "Ungültige Einladungsart."
    });
  }

  const inviter = await db
    .collection("users")
    .doc(data.inviterId)
    .get();

  if (!inviter.exists) {
    return inviteResponse(res, 404, {
      error: "Einladende Person nicht gefunden."
    });
  }

  const inviterData = inviter.data();

  if (
    inviterData.role !== "admin" &&
    inviterData.role !== "familie"
  ) {
    return inviteResponse(res, 403, {
      error: "Einladung nicht mehr gültig."
    });
  }

  return inviteResponse(res, 200, {
    ok: true,
    type: "freund",
    inviterName: inviterData.name || "Familienmitglied",
    inviterPhoto: inviterData.profilePhotoUrl || ""
  });
}
async function redeemInvite(req, res) {

  const caller = await verifyFirebaseUser(req);

  const body = await readInviteJson(req);

  const token = body.token;

  if (
    typeof token !== "string" ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    return inviteResponse(res, 400, {
      error: "Ungültiger Einladungscode."
    });
  }

  const hash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const inviteRef = db
    .collection("invites")
    .doc(hash);

  const userRef = db
    .collection("users")
    .doc(caller.uid);

  /* Einladung und Benutzer atomar aktualisieren */

  const result = await db.runTransaction(
    async (transaction) => {

      const invite = await transaction.get(inviteRef);

      const user = await transaction.get(userRef);

      if (!invite.exists) {
        return {
          status: 400,
          error: "Einladung nicht gefunden."
        };
      }

      const inviteData = invite.data();

      if (
        inviteData.usedBy ||
        inviteData.expiresAt < Date.now()
      ) {
        return {
          status: 400,
          error: "Einladung abgelaufen oder bereits verwendet."
        };
      }

      /* Bestehende Rollen dürfen nicht geändert werden */

      if (user.exists) {

        const existingRole = user.data().role;

        if (
          existingRole === "admin" ||
          existingRole === "familie" ||
          existingRole === "freund"
        ) {
          return {
            status: 409,
            error: "Dieses Konto ist bereits zugeordnet."
          };
        }
      }

      const inviterRef = db
        .collection("users")
        .doc(inviteData.inviterId);

      const inviter = await transaction.get(inviterRef);

      if (!inviter.exists) {
        return {
          status: 403,
          error: "Einladende Person nicht gefunden."
        };
      }

      const inviterData = inviter.data();

      if (
        inviterData.role !== "admin" &&
        inviterData.role !== "familie"
      ) {
        return {
          status: 403,
          error: "Einladende Person ist nicht berechtigt."
        };
      }

      /* Freundeseinladungen zusätzlich prüfen */
      let updates;
if (inviteData.type !== "freund") {
  return {
    status: 403,
    error: "Familieneinladungen sind nicht erlaubt."
  };
}

updates = {
  role: "freund",
  friendOwnerId: inviteData.inviterId
};
      
      /* Benutzerrolle speichern */

      transaction.set(
        userRef,
        updates,
        { merge: true }
      );

      /* Einladung als verwendet markieren */

      transaction.update(inviteRef, {

        usedBy: caller.uid,

        usedAt: Date.now()

      });

      return {
        status: 200,
        role: updates.role
      };
    }
  );

  if (result.status !== 200) {

    return inviteResponse(res, result.status, {
      error: result.error
    });

  }

  return inviteResponse(res, 200, {

    ok: true,

    role: result.role

  });
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
/* =====================================================
   EINLADUNGS-API
===================================================== */
if (
  req.method === "POST" &&
  (
    req.url === "/invites/create" ||
    req.url === "/invites/redeem" ||
    req.url === "/invites/preview"
  )
) {

  try {

    const allowedOrigins = [
      "https://familienchat-5fc00.web.app",
      "https://familienchat-5fc00.firebaseapp.com"
    ];

    if (
      req.headers.origin &&
      !allowedOrigins.includes(req.headers.origin)
    ) {
      return inviteResponse(res, 403, {
        error: "Origin nicht erlaubt."
      });
    }

  if (req.url === "/invites/create") {

  await createInvite(req, res);

} else if (req.url === "/invites/preview") {

  await previewInvite(req, res);

} else {

  await redeemInvite(req, res);

}
  } catch (error) {

    console.error(
      "Einladungsfehler:",
      error.message
    );

    if (!res.headersSent) {
      inviteResponse(res, 400, {
        error: "Einladung konnte nicht verarbeitet werden."
      });
    }
  }

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