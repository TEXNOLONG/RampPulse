use super::*;

impl AccountStore {
    pub fn record_fix(&self, fix: &crate::field::Fix) -> rusqlite::Result<bool> {
        let db = self.connection()?;
        Ok(db.execute("INSERT INTO field_positions(kind,agent_id,observed_ms,payload) VALUES(?1,?2,?3,?4)
            ON CONFLICT(kind,agent_id) DO UPDATE SET observed_ms=excluded.observed_ms,payload=excluded.payload
            WHERE excluded.observed_ms>field_positions.observed_ms", params![fix.kind,fix.agent_id,fix.observed_ms,serde_json::to_string(fix).unwrap()])? != 0)
    }
    pub fn field_positions(&self) -> rusqlite::Result<Vec<serde_json::Value>> {
        let db = self.connection()?;
        let mut q = db.prepare("SELECT payload FROM field_positions ORDER BY kind,agent_id")?;
        let rows = q.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|r| serde_json::from_str(&r?).map_err(|_| rusqlite::Error::InvalidQuery))
            .collect()
    }
    pub fn delete_field_position(&self, tech: i64) -> rusqlite::Result<()> {
        self.connection()?.execute(
            "DELETE FROM field_positions WHERE kind='engineer' AND agent_id=?1",
            [tech.to_string()],
        )?;
        Ok(())
    }
    pub fn due_arrival_warnings(&self) -> rusqlite::Result<Vec<(i64, i64)>> {
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO request_history(request_id,actor_id,actor_role,event,details,created_at)
            SELECT r.id,0,'system','sla_violated','15 minutes elapsed',?1 FROM requests r
            WHERE r.status IN ('waiting','assigned','enroute') AND unixepoch()-unixepoch(r.created_at)>=900
            AND NOT EXISTS(SELECT 1 FROM request_history h WHERE h.request_id=r.id AND h.event='sla_violated')", [now_rfc3339()])?;
        let alerts = {
            let mut q=tx.prepare("SELECT r.id,u.id FROM requests r JOIN users u ON u.tech_id=r.tech_id
                WHERE r.status IN ('assigned','enroute') AND u.status='active' AND u.role='engineer'
                AND unixepoch()-unixepoch(r.created_at) BETWEEN 600 AND 899
                AND NOT EXISTS(SELECT 1 FROM request_history h WHERE h.request_id=r.id AND h.event='arrival_warning' AND h.details=CAST(u.id AS TEXT))")?;
            let rows = q.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, user) in &alerts {
            tx.execute("INSERT INTO request_history(request_id,actor_id,actor_role,event,details,created_at) VALUES(?1,0,'system','arrival_warning',?2,?3)",params![id,user.to_string(),now_rfc3339()])?;
        }
        tx.commit()?;
        Ok(alerts)
    }
}
