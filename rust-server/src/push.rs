use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use ring::signature::{RsaKeyPair, RSA_PKCS1_SHA256};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{env, sync::{Arc, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";

#[derive(Clone, Deserialize)]
struct ServiceAccount { project_id: String, client_email: String, private_key: String }
#[derive(Clone)]
struct CachedToken { value: String, expires: Instant }
struct Inner { account: ServiceAccount, http: reqwest::Client, token: Mutex<Option<CachedToken>> }
#[derive(Clone)]
pub struct PushService(Arc<Inner>);

impl PushService {
    pub fn from_env() -> Option<Self> {
        let raw = env::var("FCM_SERVICE_ACCOUNT_JSON").ok().or_else(|| {
            std::fs::read_to_string(env::var("GOOGLE_APPLICATION_CREDENTIALS").ok()?).ok()
        })?;
        match serde_json::from_str::<ServiceAccount>(&raw) {
            Ok(account) if !account.project_id.is_empty() && !account.private_key.is_empty() => Some(Self(Arc::new(Inner { account, http: reqwest::Client::new(), token: Mutex::new(None) }))),
            Ok(_) => { eprintln!("FCM disabled: service account missing required fields"); None },
            Err(error) => { eprintln!("FCM disabled: invalid service-account JSON: {error}"); None },
        }
    }

    pub async fn send(&self, device: &str, title: &str, body: &str, data: Value) -> Result<(), String> {
        let token = self.access_token().await?;
        let ttl = if data.get("kind").and_then(Value::as_str) == Some("call") { "90s" } else { "86400s" };
        let mut fields = data.as_object().cloned().unwrap_or_default();
        fields.insert("title".into(), Value::String(title.into()));
        fields.insert("body".into(), Value::String(body.into()));
        let data: serde_json::Map<String, Value> = fields.into_iter().map(|(k,v)| (k, Value::String(if v.is_string() { v.as_str().unwrap_or_default().into() } else { v.to_string() }))).collect();
        let response = self.0.http.post(format!("https://fcm.googleapis.com/v1/projects/{}/messages:send", self.0.account.project_id))
            .bearer_auth(token).json(&json!({"message":{"token":device,"data":data,"android":{"priority":"HIGH","ttl":ttl}}})).send().await.map_err(|e| e.to_string())?;
        if response.status().is_success() { return Ok(()); }
        let status = response.status(); let detail = response.text().await.unwrap_or_default();
        Err(format!("FCM {status}: {}", detail.chars().take(300).collect::<String>()))
    }

    async fn access_token(&self) -> Result<String, String> {
        if let Some(token) = self.0.token.lock().map_err(|_| "FCM token lock poisoned")?.clone() {
            if token.expires > Instant::now() + Duration::from_secs(60) { return Ok(token.value); }
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims = json!({"iss":self.0.account.client_email,"scope":SCOPE,"aud":TOKEN_URL,"iat":now,"exp":now+3600});
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|e| e.to_string())?);
        let mut assertion = format!("{header}.{payload}");
        let pem = self.0.account.private_key.lines().filter(|line| !line.starts_with("-----")).collect::<String>();
        let key = RsaKeyPair::from_pkcs8(&STANDARD.decode(pem).map_err(|e| e.to_string())?).map_err(|_| "FCM key must be PKCS#8 RSA")?;
        let mut signature = vec![0; key.public().modulus_len()];
        key.sign(&RSA_PKCS1_SHA256, &ring::rand::SystemRandom::new(), assertion.as_bytes(), &mut signature).map_err(|_| "FCM JWT signing failed")?;
        assertion.push('.'); assertion.push_str(&URL_SAFE_NO_PAD.encode(signature));
        let response = self.0.http.post(TOKEN_URL).form(&[("grant_type","urn:ietf:params:oauth:grant-type:jwt-bearer"),("assertion",assertion.as_str())]).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() { return Err(format!("FCM OAuth {}", response.status())); }
        #[derive(Deserialize)] struct Token { access_token: String, expires_in: u64 }
        let token: Token = response.json().await.map_err(|e| e.to_string())?;
        *self.0.token.lock().map_err(|_| "FCM token lock poisoned")? = Some(CachedToken { value: token.access_token.clone(), expires: Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(90)) });
        Ok(token.access_token)
    }
}
