const pool = require('../config/db');

async function sendMessage({ incidentId, ambulanceId, senderUserId, senderRole, senderName, body }) {
  const [result] = await pool.query(
    `INSERT INTO mission_messages (incident_id, ambulance_id, sender_user_id, sender_role, body)
     VALUES (:incidentId, :ambulanceId, :senderUserId, :senderRole, :body)`,
    { incidentId, ambulanceId, senderUserId, senderRole, body }
  );
  const [[row]] = await pool.query('SELECT sent_at FROM mission_messages WHERE id = :id', { id: result.insertId });

  return {
    id: result.insertId,
    incidentId,
    ambulanceId,
    senderUserId,
    senderRole,
    senderName,
    body,
    sentAt: row.sent_at,
  };
}

async function listForIncident(incidentId, limit = 100) {
  // LIMIT inlined (not bound) -- mysql2 named placeholders don't reliably
  // bind LIMIT as an integer; safe here since `limit` is a server-side
  // default, never user input, and coerced to an int regardless.
  const safeLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
  const [rows] = await pool.query(
    `SELECT mm.id, mm.incident_id AS incidentId, mm.ambulance_id AS ambulanceId,
            mm.sender_user_id AS senderUserId, mm.sender_role AS senderRole, u.name AS senderName,
            mm.body, mm.sent_at AS sentAt
     FROM mission_messages mm
     JOIN users u ON u.id = mm.sender_user_id
     WHERE mm.incident_id = :incidentId
     ORDER BY mm.sent_at ASC
     LIMIT ${safeLimit}`,
    { incidentId }
  );
  return rows;
}

module.exports = {
  sendMessage,
  listForIncident,
};
