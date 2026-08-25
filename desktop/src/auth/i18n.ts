import type { Language } from "../store";

export const LOGIN_COPY: Record<Language, {
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
}> = {
  cn: {
    tabLogin: "登录",
    tabRegister: "注册",
    authMethodAriaLabel: "认证方式",
    brandSubLogin: "登录以继续",
    brandSubRegister: "创建 New API 账号",
    taglineMain: "梦中求索，醒时有获",
    taglineSub: "SEEK IN DREAMS, HARVEST ON WAKING.",
    accountLabel: "账号",
    usernamePlaceholder: "用户名",
    passwordLabel: "密码",
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
    turnstileNotice: "人机验证服务由 Cloudflare 提供支持",
    openWebRegister: "打开网页版注册",
    submitLogin: "登录",
    submitRegister: "注册并登录",
    submitLoggingIn: "登录中...",
    submitRegistering: "注册中...",
    fetchStatusFailed: (message) => `获取服务器状态失败: ${message}`,
    errorEmailRequired: "请先输入邮箱后再获取验证码",
    errorTurnstileRequired: "请先完成人机验证后再获取验证码",
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
  },
  en: {
    tabLogin: "Log in",
    tabRegister: "Sign up",
    authMethodAriaLabel: "Authentication method",
    brandSubLogin: "Sign in to continue",
    brandSubRegister: "Create a New API account",
    taglineMain: "Seek in Dreams, harvest on waking",
    taglineSub: "SEEK IN DREAMS, HARVEST ON WAKING.",
    accountLabel: "Account",
    usernamePlaceholder: "Username",
    passwordLabel: "Password",
    passwordPlaceholderLogin: "Password",
    passwordPlaceholderRegister: "8-20 characters",
    confirmPasswordLabel: "Confirm password",
    confirmPasswordPlaceholder: "Re-enter your password",
    emailLabel: "Email",
    emailPlaceholder: "name@example.com",
    verificationCodeLabel: "Verification code",
    verificationCodePlaceholder: "Email verification code",
    sendCode: "Send",
    sendingCode: "Sending",
    sendCodeCooldown: (seconds) => `${seconds}s`,
    legalAgreement: "I have read and agree to the Terms of Service and Privacy Policy",
    turnstileNotice: "This server has bot verification enabled. Please register on the web and then return to sign in.",
    openWebRegister: "Open web registration",
    submitLogin: "Log in",
    submitRegister: "Create account",
    submitLoggingIn: "Logging in...",
    submitRegistering: "Signing up...",
    fetchStatusFailed: (message) => `Could not read the server's registration settings: ${message}`,
    errorEmailRequired: "Please enter your email first",
    errorTurnstileRequired: "This server has bot verification enabled. Please complete registration on the web first",
    noticeCodeSent: "Verification code sent, please check your inbox",
    errorStatusLoading: "Reading the server's registration settings, please wait",
    errorRegisterNotSupported: "This server does not support account/password registration",
    errorPasswordMismatch: "The two passwords you entered do not match",
    errorPasswordLength: "Password must be 8-20 characters",
    errorLegalRequired: "Please agree to the relevant terms first",
    errorEmailRequiredShort: "Please enter your email",
    errorVerificationCodeRequired: "Please enter the verification code",
    noticeRegisterSuccess: "Registration successful, please log in",
    errorPasswordLoginNotSupported: "This server does not support account/password login",
  },
};
