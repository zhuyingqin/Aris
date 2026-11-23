import type { Language } from "../store";

export const LOGIN_COPY: Record<Language, {
  twoFactorLabel: string;
  twoFactorPlaceholder: string;
  twoFactorNotice: string;
  twoFactorRequired: string;
  tabLogin: string;
  tabRegister: string;
  authMethodAriaLabel: string;
  brandSubLogin: string;
  brandSubRegister: string;
  taglineMain: string;
  taglineSub: string;
  accountLabel: string;
  usernamePlaceholder: string;
  passwordLabel: string;
  forgotPassword: string;
  passwordPlaceholderLogin: string;
  passwordPlaceholderRegister: string;
  confirmPasswordLabel: string;
  confirmPasswordPlaceholder: string;
  emailLabel: string;
  emailPlaceholder: string;
  verificationCodeLabel: string;
  verificationCodePlaceholder: string;
  sendCode: string;
  sendingCode: string;
  sendCodeCooldown: (seconds: number) => string;
  legalAgreement: string;
  turnstileNotice: string;
  openWebRegister: string;
  submitLogin: string;
  submitRegister: string;
  submitLoggingIn: string;
  submitRegistering: string;
  fetchStatusFailed: (message: string) => string;
  gatewayUnavailable: string;
  errorEmailRequired: string;
  errorTurnstileRequired: string;
  noticeCodeSent: string;
  errorStatusLoading: string;
  errorRegisterNotSupported: string;
  errorPasswordMismatch: string;
  errorPasswordLength: string;
  errorLegalRequired: string;
  errorEmailRequiredShort: string;
  errorVerificationCodeRequired: string;
  noticeRegisterSuccess: string;
  errorPasswordLoginNotSupported: string;
  verifyingAuth: string;
  verifyingAuthSub: string;
}> = {
  cn: {
    twoFactorLabel: "两步验证码",
    twoFactorPlaceholder: "验证器验证码或备用码",
    twoFactorNotice: "请输入验证器中的验证码或备用码，完成登录。",
    twoFactorRequired: "请输入两步验证码",
    tabLogin: "登录",
    tabRegister: "注册",
    authMethodAriaLabel: "认证方式",
    brandSubLogin: "登录以继续",
    brandSubRegister: "创建 SomniQ 账号",
    taglineMain: "梦中求索，醒时有获",
    taglineSub: "SEEK IN DREAMS, HARVEST ON WAKING.",
    accountLabel: "账号",
    usernamePlaceholder: "用户名",
    passwordLabel: "密码",
    forgotPassword: "忘记密码？",
    passwordPlaceholderLogin: "密码",
    passwordPlaceholderRegister: "8-20 位密码",
    confirmPasswordLabel: "确认密码",
    confirmPasswordPlaceholder: "再次输入密码",
    emailLabel: "邮箱",
    emailPlaceholder: "name@example.com",
    verificationCodeLabel: "验证码",
    verificationCodePlaceholder: "输入邮箱验证码",
    sendCode: "获取验证码",
    sendingCode: "发送中",
    sendCodeCooldown: (seconds) => `${seconds} 秒后重发`,
    legalAgreement: "我已阅读并同意服务条款与隐私政策",
    turnstileNotice: "当前服务器开启了 Cloudflare 人机验证，应用内无法完成。请在网页端注册后再回来登录。",
    openWebRegister: "打开网页版注册",
    submitLogin: "登录",
    submitRegister: "创建账号",
    submitLoggingIn: "登录中...",
    submitRegistering: "注册中...",
    fetchStatusFailed: (message) => `获取服务器状态失败: ${message}`,
    gatewayUnavailable: "此安装包未配置可用的 HTTPS 托管账号服务器。请联系发布者更新安装包。",
    errorEmailRequired: "请先输入邮箱后再获取验证码",
    errorTurnstileRequired: "当前服务器需要人机验证，请先在网页端注册",
    noticeCodeSent: "验证码已发送，请查收",
    errorStatusLoading: "正在连接认证服务器，请稍后...",
    errorRegisterNotSupported: "当前服务器未开放直接注册",
    errorPasswordMismatch: "两次输入的密码不一致",
    errorPasswordLength: "密码长度需在 8 到 20 位之间",
    errorLegalRequired: "请勾选同意服务条款与隐私政策",
    errorEmailRequiredShort: "请输入邮箱",
    errorVerificationCodeRequired: "请输入验证码",
    noticeRegisterSuccess: "注册成功，请登录",
    errorPasswordLoginNotSupported: "当前服务器未开放账号密码登录",
    verifyingAuth: "正在验证登录状态...",
    verifyingAuthSub: "正在校验安全凭证与网关连接...",
  },
  en: {
    twoFactorLabel: "Two-step verification code",
    twoFactorPlaceholder: "Authenticator code or backup code",
    twoFactorNotice: "Enter your authenticator code or a backup code to finish signing in.",
    twoFactorRequired: "Enter your two-step verification code",
    tabLogin: "Sign in",
    tabRegister: "Sign up",
    authMethodAriaLabel: "Authentication method",
    brandSubLogin: "Sign in to continue",
    brandSubRegister: "Create a SomniQ account",
    taglineMain: "Seek in dreams, harvest on waking",
    taglineSub: "SEEK IN DREAMS, HARVEST ON WAKING.",
    accountLabel: "Account",
    usernamePlaceholder: "Username",
    passwordLabel: "Password",
    forgotPassword: "Forgot password?",
    passwordPlaceholderLogin: "Password",
    passwordPlaceholderRegister: "8–20 characters",
    confirmPasswordLabel: "Confirm password",
    confirmPasswordPlaceholder: "Re-enter your password",
    emailLabel: "Email",
    emailPlaceholder: "name@example.com",
    verificationCodeLabel: "Verification code",
    verificationCodePlaceholder: "Email verification code",
    sendCode: "Send code",
    sendingCode: "Sending",
    sendCodeCooldown: (seconds) => `Resend in ${seconds}s`,
    legalAgreement: "I have read and agree to the Terms of Service and Privacy Policy",
    turnstileNotice: "This server uses Cloudflare human verification, which the app can't complete. Sign up on the web, then come back to sign in.",
    openWebRegister: "Open web registration",
    submitLogin: "Sign in",
    submitRegister: "Create account",
    submitLoggingIn: "Signing in…",
    submitRegistering: "Signing up…",
    fetchStatusFailed: (message) => `Couldn't get the server status: ${message}`,
    gatewayUnavailable: "This installer has no valid HTTPS managed account server configured. Contact the publisher for an updated installer.",
    errorEmailRequired: "Enter your email before requesting a code",
    errorTurnstileRequired: "This server requires human verification. Sign up on the web first",
    noticeCodeSent: "Verification code sent. Check your inbox",
    errorStatusLoading: "Connecting to the authentication server, please wait…",
    errorRegisterNotSupported: "This server doesn't allow direct registration",
    errorPasswordMismatch: "The two passwords you entered do not match",
    errorPasswordLength: "Password must be 8–20 characters",
    errorLegalRequired: "Please accept the Terms of Service and Privacy Policy",
    errorEmailRequiredShort: "Please enter your email",
    errorVerificationCodeRequired: "Please enter the verification code",
    noticeRegisterSuccess: "Account created. Please sign in",
    errorPasswordLoginNotSupported: "This server doesn't allow password sign-in",
    verifyingAuth: "Checking sign-in status…",
    verifyingAuthSub: "Validating secure credentials and the gateway connection…",
  },
  es: {
    twoFactorLabel: "Código de verificación en dos pasos",
    twoFactorPlaceholder: "Código del autenticador o código de respaldo",
    twoFactorNotice: "Introduce el código de tu autenticador o un código de respaldo para terminar de iniciar sesión.",
    twoFactorRequired: "Introduce tu código de verificación en dos pasos",
    tabLogin: "Iniciar sesión",
    tabRegister: "Registrarse",
    authMethodAriaLabel: "Método de autenticación",
    brandSubLogin: "Inicia sesión para continuar",
    brandSubRegister: "Crea una cuenta de SomniQ",
    taglineMain: "Busca en sueños, cosecha al despertar",
    taglineSub: "SEEK IN DREAMS, HARVEST ON WAKING.",
    accountLabel: "Cuenta",
    usernamePlaceholder: "Nombre de usuario",
    passwordLabel: "Contraseña",
    forgotPassword: "¿Olvidaste tu contraseña?",
    passwordPlaceholderLogin: "Contraseña",
    passwordPlaceholderRegister: "Entre 8 y 20 caracteres",
    confirmPasswordLabel: "Confirmar contraseña",
    confirmPasswordPlaceholder: "Vuelve a escribir tu contraseña",
    emailLabel: "Correo electrónico",
    emailPlaceholder: "name@example.com",
    verificationCodeLabel: "Código de verificación",
    verificationCodePlaceholder: "Código de verificación del correo",
    sendCode: "Enviar código",
    sendingCode: "Enviando",
    sendCodeCooldown: (seconds) => `Reenviar en ${seconds} s`,
    legalAgreement: "He leído y acepto los Términos del servicio y la Política de privacidad",
    turnstileNotice: "Este servidor usa la verificación humana de Cloudflare, que la app no puede completar. Regístrate en la web y vuelve para iniciar sesión.",
    openWebRegister: "Abrir el registro web",
    submitLogin: "Iniciar sesión",
    submitRegister: "Crear cuenta",
    submitLoggingIn: "Iniciando sesión…",
    submitRegistering: "Registrando…",
    fetchStatusFailed: (message) => `No se pudo obtener el estado del servidor: ${message}`,
    gatewayUnavailable: "Este instalador no tiene configurado un servidor de cuentas gestionado HTTPS válido. Pide al editor un instalador actualizado.",
    errorEmailRequired: "Introduce tu correo antes de solicitar el código",
    errorTurnstileRequired: "Este servidor requiere verificación humana. Regístrate primero en la web",
    noticeCodeSent: "Código de verificación enviado; revisa tu bandeja de entrada",
    errorStatusLoading: "Conectando con el servidor de autenticación, espera…",
    errorRegisterNotSupported: "Este servidor no permite el registro directo",
    errorPasswordMismatch: "Las dos contraseñas no coinciden",
    errorPasswordLength: "La contraseña debe tener entre 8 y 20 caracteres",
    errorLegalRequired: "Acepta los Términos del servicio y la Política de privacidad",
    errorEmailRequiredShort: "Introduce tu correo electrónico",
    errorVerificationCodeRequired: "Introduce el código de verificación",
    noticeRegisterSuccess: "Registro completado; inicia sesión",
    errorPasswordLoginNotSupported: "Este servidor no permite iniciar sesión con contraseña",
    verifyingAuth: "Verificando el inicio de sesión…",
    verifyingAuthSub: "Validando las credenciales seguras y la conexión con la pasarela…",
  },
};
