use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub fn random() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

#[derive(Clone)]
pub struct Vault(Aes256Gcm);

impl Vault {
    pub fn new(encoded: &str) -> Result<Self, String> {
        let key = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "SOMNIQ_ACCOUNT_KEY must be base64url")?;
        if key.len() != 32 {
            return Err("SOMNIQ_ACCOUNT_KEY must encode 32 random bytes".into());
        }
        Ok(Self(
            Aes256Gcm::new_from_slice(&key).map_err(|_| "invalid vault key")?,
        ))
    }

    pub fn seal(&self, context: &str, text: &str) -> Result<String, String> {
        let mut nonce = [0_u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let encrypted = self
            .0
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: text.as_bytes(),
                    aad: context.as_bytes(),
                },
            )
            .map_err(|_| "credential encryption failed")?;
        Ok(URL_SAFE_NO_PAD.encode([nonce.as_slice(), &encrypted].concat()))
    }

    pub fn open(&self, context: &str, sealed: &str) -> Result<String, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(sealed)
            .map_err(|_| "invalid encrypted credential")?;
        if bytes.len() < 28 {
            return Err("invalid encrypted credential".into());
        }
        let nonce: [u8; 12] = bytes[..12].try_into().map_err(|_| "invalid nonce")?;
        let plain = self
            .0
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &bytes[12..],
                    aad: context.as_bytes(),
                },
            )
            .map_err(|_| "credential decryption failed")?;
        String::from_utf8(plain).map_err(|_| "invalid credential encoding".into())
    }
}
