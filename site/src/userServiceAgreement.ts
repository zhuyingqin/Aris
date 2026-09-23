import type { Lang } from "./i18n";

export { USER_SERVICE_AGREEMENT_VERSION, USER_SERVICE_AGREEMENT_UPDATED_AT } from "./agreementConfig";
export const LEGAL_SUPPORT_EMAIL = "support@somni.chat";
export const SERVICE_PROVIDER_ADDRESS = (import.meta.env.VITE_SOMNIQ_MERCHANT_ADDRESS ?? "").trim();

export interface AgreementSection {
  id: string;
  title: string;
  paragraphs: { text: string; important?: boolean }[];
}

interface UserServiceAgreementCopy {
  title: string;
  intro: string;
  version: string;
  updated: string;
  effective: string;
  effectiveValue: string;
  provider: string;
  providerPending: string;
  address: string;
  addressPending: string;
  contact: string;
  noticeTitle: string;
  notice: string;
  contents: string;
  offer: { title: string; plan: string; merchant: string; amount: string; perMonth: string; period: string; periodValue: string; method: string; methodValue: string };
  sections: AgreementSection[];
}

const zh: UserServiceAgreementCopy = {
  title: "用户服务协议",
  intro: "欢迎使用 SomniQ Studio。本协议约定您与 SomniQ Studio 运营主体在使用网站、账号、科研工作台及相关在线服务时的权利与义务。请在注册、购买或启用相关服务前完整阅读，并保存与您有关的协议及订单信息。",
  version: "协议版本",
  updated: "更新日期",
  effective: "生效方式",
  effectiveValue: "自您确认同意之日起对您生效；已有用户适用第十五条的更新规则。",
  provider: "服务提供者",
  providerPending: "SomniQ Studio（运营主体法定名称待确认）",
  address: "联系地址",
  addressPending: "运营主体联系地址待确认",
  contact: "服务与投诉邮箱",
  noticeTitle: "请重点阅读",
  notice: "付费与退款、自动续费、数据发送、AI 输出局限、服务责任及争议处理等条款与您的权益密切相关，已在下文加粗提示。注册账号不等于购买会员；同意本协议不等于授权自动扣款，也不替代依法需要另行取得的个人信息处理同意。",
  contents: "条款目录",
  offer: {
    title: "当前月度续费方案（仅在主动开通后适用）",
    plan: "服务名称", merchant: "扣款主体", amount: "每周期金额", perMonth: "月",
    period: "扣款周期",
    periodValue: "每个自然月，在签约日对应日期扣款；当月没有对应日期时，于当月最后一日扣款。首次及后续扣款日期以您在支付渠道确认的签约信息和订单为准。",
    method: "扣款方式",
    methodValue: "完成授权后，支付机构按约定从您已授权的支付方式自动扣款。本方案不适用于未开通续费的账号或其他套餐。",
  },
  sections: [
    {
      id: "scope",
      title: "协议适用与接受",
      paragraphs: [
        { text: "本协议中的“我们”指本页公示的 SomniQ Studio 运营主体，“您”指使用服务的个人或依法授权的组织。本协议适用于 SomniQ Studio 网站、账号及其提供的相关服务；桌面软件中另有明确许可的组件，依其许可使用。" },
        { text: "您在注册或其他明确提示的环节主动勾选同意本协议后，双方依本协议开展相应服务。单纯浏览网站不视为同意购买、自动续费或额外的数据处理。对条款有疑问时，可通过本页邮箱要求说明。" },
        { text: "具体订单及您另行确认的专项协议可补充服务范围、价格与履行方式。单独协商的约定依法优先适用；任何页面规则、专项协议或翻译均不得排除法律赋予您的强制性权利。" },
      ],
    },
    {
      id: "services",
      title: "服务内容与使用条件",
      paragraphs: [
        { text: "SomniQ Studio 是本地优先的科研工作台，辅助开展选题、文献整理、实验、证据分析及写作，并可提供模型调用、独立审查、账号、会员和远程连接等功能。实际可用功能取决于已发布版本、您的设备、配置及所选服务。" },
        { text: "付费功能、模型范围、算力额度、服务期限与使用限制，应以购买前向您明确展示并确认的套餐和订单为准。试用、测试或规划中的功能应按其标注理解，不当然属于已购买的服务；我们应履行已向您作出的具体服务承诺。" },
      ],
    },
    {
      id: "account",
      title: "账号与使用资格",
      paragraphs: [
        { text: "您应具有订立及履行本协议所需的民事行为能力。未成年人应在监护人指导下使用，并在依法需要时取得监护人同意；代表学校、实验室或其他组织使用时，应已获得相应授权。" },
        { text: "请提供真实、准确且必要的注册信息，及时更新联系信息，妥善保管密码、API 密钥及设备授权。未经允许，不得出售、出租账号或向无权使用的人开放账号及配对设备。" },
        { text: "发现账号、密钥或已配对设备可能被冒用时，请及时采取修改密码、撤销授权等措施并联系我们。我们将协助核查并采取必要的保护措施；相关损失依据双方过错、因果关系及法律规定处理，不因操作发生在您的账号下就当然由您承担全部责任。" },
      ],
    },
    {
      id: "acceptable-use",
      title: "合规使用与学术诚信",
      paragraphs: [
        { text: "您应确保有权使用输入的文献、代码、数据及其他材料，遵守适用法律、数据授权、保密义务、研究伦理以及所在机构、期刊和会议的规则。涉及他人个人信息、未公开成果或受限数据时，应事先取得必要授权。" },
        { text: "不得利用服务侵犯他人权益，传播违法内容，实施欺诈、恶意攻击、未授权访问，窃取账号或密钥，或以技术手段恶意绕过计费、访问及安全限制。不得将编造的引用、实验数据或审查结果冒充真实研究证据。对依法或依开源许可允许的行为，本协议不额外限制。" },
      ],
    },
    {
      id: "automation",
      title: "自动化任务与权限",
      paragraphs: [
        { text: "自动化任务可在您设定的范围内读取或修改文件、运行代码、调用模型及连接外部服务。启动任务前，请核对工作目录、工具权限、预算、停止条件和外部服务设置，并为重要文件保留备份。" },
        { text: "持续执行和反复审查可能产生多次模型调用或其他费用。权限授予应以您明确配置或确认的范围为边界；发布、发送材料、支付、删除等影响较大的操作，应依产品提示及相应授权执行。授权任务不构成对任意外部操作或无限费用的同意。", important: true },
      ],
    },
    {
      id: "ai-output",
      title: "AI 输出与研究判断",
      paragraphs: [
        { text: "模型输出及自动审查可能包含事实、引用、计算或代码错误，也可能不完整、过时或与他人输出相似。独立 Reviewer 和修订流程用于辅助检查，不构成人工专家背书，也不保证结果正确、具有原创性、能够复现或被发表、录用。", important: true },
        { text: "在采用、公开或提交结果前，您应核验原始文献、数据来源、实验记录、代码及结论，遵守适用的 AI 使用披露和生成内容标识要求。涉及医疗、法律、财务或其他重大决策时，还应获得相应专业判断。以上提示不免除我们对产品质量、安全及具体承诺依法应承担的责任。" },
      ],
    },
    {
      id: "data",
      title: "本地数据与个人信息",
      paragraphs: [
        { text: "本地优先是指项目文件和研究记录主要保存在您选择的本地工作空间。调用在线模型、搜索、插件、远程连接或协作功能时，相关提示词、上下文、文件片段或连接信息可能按所选功能发送给相应服务方；本地保存不意味着所有处理都离线完成。请在使用前核对接收方和数据范围。", important: true },
        { text: "提供账号、安全、计费及支持服务所必要的信息，可能包括注册信息、身份验证信息、设备连接信息、用量、订单及故障记录。我们应遵循合法、正当、必要和最短必要保存原则，并通过适用的隐私告知说明具体处理目的、方式、种类、保存期限和权利行使渠道。本条不替代完整的隐私告知。" },
        { text: "同意本协议不构成向我们授权公开您的未公开研究材料、将其用于营销或用于与本次服务无关的模型训练。涉及敏感个人信息、向其他处理者提供信息或跨境传输时，应依法履行告知及相应义务，并在法律要求时另行取得单独同意；第三方自己的处理活动还需查看其隐私规则。" },
        { text: "您可通过本页邮箱申请查阅、复制、更正、删除个人信息、撤回基于同意的授权或注销账号。我们将在必要的身份核验后依法处理并说明结果；拒绝或撤回非必要的信息处理同意，不应妨碍您使用不依赖该信息的服务。" },
      ],
    },
    {
      id: "intellectual-property",
      title: "知识产权与内容授权",
      paragraphs: [
        { text: "您及原权利人对输入材料享有的权利不因使用服务而转移。为完成您请求的处理，我们仅在提供该服务所必需的范围和期间内处理相关内容；对外公开、推广或其他超出该目的的使用，需要另行获得合法授权。" },
        { text: "生成内容的权利归属及可使用范围依适用法律、输入材料权利和所选第三方服务条款确定。我们不因代为生成而主张您原有研究成果的所有权，也不保证生成内容必然享有著作权、具有独占性或不涉及他人权利。" },
        { text: "SomniQ Studio 的商标、界面及我们拥有权利的软件内容受到相应法律保护。第三方和开源组件适用各自的许可；本协议不撤回、缩减或替代您已从这些许可取得的合法权利。" },
      ],
    },
    {
      id: "billing",
      title: "付费服务、额度与订单",
      paragraphs: [
        { text: "购买前应明确展示服务项目、币种、价格、计费单位、有效期及使用限制，包括适用的额度消耗、重置、结转或到期规则。您确认订单并完成支付后，按照订单约定获得权益；会员权益和可消耗的模型额度应分别理解。" },
        { text: "服务消耗可能随模型、输入输出长度和任务执行次数变化，以购买时确认的计费规则及实际使用记录核算。额度不足后的继续计费或额外购买须有相应授权；对未在购买前说明的限制或费用，我们不得事后单方追加。", important: true },
        { text: "价格或套餐调整应提前公示并在新订单或依法确认的后续周期适用，不追溯改变已支付订单。订单、发票或其他支付凭证及账单问题可通过本页邮箱申请核查；依法应提供的发票或凭证，我们将依规办理。" },
      ],
    },
    {
      id: "auto-renewal",
      title: "自动续费、扣款授权与取消",
      paragraphs: [
        { text: "本章是本用户服务协议的组成部分，约定自动续费及扣款授权规则。自动续费仅在功能已开放、您在购买页主动勾选确认本协议中的自动续费条款、点击“确认开通自动续费”并完成支付渠道签约后开通。注册、登录、购买一次性服务、同意本协议或仅勾选确认框，均不单独完成支付签约或产生自动扣款授权。", important: true },
        { text: "开通前，我们应明确展示服务名称、扣款主体、金额、周期及取消方式，供您核对并自主选择。授权是否生效以支付渠道和服务端的有效签约记录为准；我们应保留您确认的协议版本、授权范围和签约记录。" },
        { text: "签约有效期间，按您确认的金额和周期扣款；我们会在每次自动扣款前以显著方式提醒扣款时间、金额和取消路径。收费标准变更时应事先通知，未取得您对新金额的确认前，不按新金额自动扣款。授权范围以本章及您实际确认的订单、支付签约信息为准。" },
        { text: "已签约用户可通过“个人中心 → 我的会员 → 自动续费管理”申请关闭，或通过支付渠道支持的解约入口及本页邮箱寻求协助。成功关闭后不再发起后续周期扣款，已支付权益保留至本周期到期；已经发生的扣款依退款条款处理。卸载软件、退出登录或停止使用不等于关闭自动续费。", important: true },
        { text: "您可在自动续费管理中查询签约状态、当前权益到期时间、下次扣款日期及金额。扣款失败时，权益是否延续以实际订单及支付结果为准，不应在未收款或未交付的情况下显示已续费成功。发现未授权扣款、金额错误或关闭成功后仍发生续费扣款，请提供订单号和问题说明至 support@somni.chat，我们将核对支付渠道记录，依第十一条处理更正和退款。" },
      ],
    },
    {
      id: "refunds",
      title: "退款与账单异议",
      paragraphs: [
        { text: "如发生重复收费、未经授权的扣款、金额错误、已付费但未交付权益，或因我们的原因无法按约提供服务，您可以申请核查、补足履行或依法退款。我们不以“虚拟商品”或“已开通”为由一概排除您依法享有的退款和救济权利。", important: true },
        { text: "对依法或依订单约定可退还的未履行部分，退款应以实际支付金额、已实际履行的期限或可核验的用量及购买前明确的规则核算，并向您说明计算依据。无法继续提供已付费服务时，应依法处理未消费的预付款，不得强制以优惠券替代退款。" },
        { text: "申请时请提供账号标识、订单号、支付时间、争议金额及问题说明，勿发送密码、验证码或完整银行卡号。我们会核对双方证据并反馈处理依据、金额和预计时限；退款原则上退回原支付渠道，确有困难时与您协商其他合法方式，法定处理期限优先适用。正常已履行部分能否退还，依法律和购买时确认的规则处理。" },
      ],
    },
    {
      id: "third-parties",
      title: "第三方服务与远程连接",
      paragraphs: [
        { text: "外部模型、文献数据库、支付机构、插件及您自行配置的 API 可能由第三方提供。启用前请阅读其价格、授权和隐私规则；您直接向第三方购买的服务，由该第三方按其约定履行。对于我们承诺并向您收费的服务，我们不因采用第三方组件而免除自身的合同责任。" },
        { text: "远程设备配对、工具接入及互助功能可能允许经授权的另一设备或参与者处理您选择的内容。请仅授予必要权限，并在不再需要时撤销；涉及他人账号、素材或设备时，应先取得授权。相应功能的实际提示决定本次连接或共享范围。" },
      ],
    },
    {
      id: "availability-liability",
      title: "服务变更、中断与责任",
      paragraphs: [
        { text: "我们将采取合理措施维护服务的可用性和安全性。计划维护、重要功能调整或服务停止，应提前通过适当渠道告知；突发安全事件、网络故障等无法提前通知的情形，应及时说明并尽力恢复或减轻影响。" },
        { text: "如调整实质影响已购买权益，我们应与您协商继续履行、提供您接受的替代方案或退还未履行部分。因不可抗力影响履约的，双方根据实际影响及法律规定承担相应责任，并及时履行通知、减损等义务；普通技术故障不当然构成免责理由。" },
        { text: "双方因违约或侵权造成损失的，依法结合过错、因果关系及损失情况承担责任。本协议不排除或限制因人身损害、故意或重大过失造成财产损失等依法不得免除的责任，也不排除消费者依法获得赔偿、解除合同或其他救济的权利。", important: true },
      ],
    },
    {
      id: "termination",
      title: "账号注销与服务终止",
      paragraphs: [
        { text: "您可以停止使用服务，并通过本页邮箱申请注销账号。注销前，请备份所需记录，核对未结算订单、退款及自动续费授权；我们应协助处理相关事项，并在注销时核验及处理以该账号开通的持续扣款授权，告知您结果。" },
        { text: "存在违法使用、严重违约或账号被盗等合理迹象时，我们可采取与风险相适应的限制或暂停措施。除依法不能告知或需紧急处置外，应向您说明原因、影响范围和申诉方式；核查后应及时恢复无须继续限制的服务。对处理有异议，可提交材料申请复核。" },
        { text: "账号注销或服务终止后，在线权益和账号访问可能停止；我们应依法删除或匿名化不再必要的个人信息，对依法必须保存的记录限制其用途及保存期间。账号注销不会自动删除您设备上的项目文件，您应自行管理本地副本。终止不消灭此前产生的退款请求、合法债权或依法持续有效的义务。", important: true },
      ],
    },
    {
      id: "updates",
      title: "协议更新与通知",
      paragraphs: [
        { text: "因功能、业务或法律变化需要修订本协议时，我们将在本页注明新版本和更新日期，并通过网站、应用内提示或您留存的有效联系方式，在生效前合理通知。涉及费用、数据使用、责任或其他重大权益的变更，应显著提示并在依法需要时重新取得您的明确同意。" },
        { text: "新条款不当然追溯适用于已完成的交易，也不以单纯继续浏览替代依法需要的同意。如不接受重大变更，您可停止相应服务，并就尚未履行的已付费部分依约、依法处理。服务通知与商业推广应区分，营销信息应遵循适用的同意及退订规则。" },
      ],
    },
    {
      id: "law-contact",
      title: "法律适用、争议处理与联系",
      paragraphs: [
        { text: "本协议的订立、效力、履行及争议处理依据依法适用的法律确定。面向中国大陆用户提供服务时，应遵守《中华人民共和国民法典》《中华人民共和国消费者权益保护法》《中华人民共和国个人信息保护法》等适用规定；其他地区依法适用的强制性保护规定不因本协议而被排除。" },
        { text: "有关账号、费用、个人信息、侵权或本协议的问题，可发送至 support@somni.chat。我们将在收到必要信息后核查、说明处理结果并提供进一步沟通渠道。您可与我们协商，也可依法向有关部门投诉、申请调解或向有管辖权的人民法院起诉；仲裁须有双方另行有效的仲裁约定，不以先行协商作为您行使法定权利的前提。", important: true },
        { text: "某项条款依法无效或不可执行，不影响其余条款的效力。各语言版本旨在表达相同内容；出现歧义时，应结合适用法律、订约过程及公平原则解释，不以语言差异减损您的合法权利。" },
      ],
    },
  ],
};

const en: UserServiceAgreementCopy = {
  title: "User Service Agreement",
  intro: "Welcome to SomniQ Studio. This agreement sets out your rights and obligations, and those of the SomniQ Studio operator, when using the website, accounts, research workspace and related online services. Read it before registering, purchasing or enabling a service, and retain the terms and order details relevant to you.",
  version: "Agreement version",
  updated: "Last updated",
  effective: "When it applies",
  effectiveValue: "Applies when you expressly accept it; updates for existing users follow Section 15.",
  provider: "Service provider",
  providerPending: "SomniQ Studio (legal operator name pending)",
  address: "Contact address",
  addressPending: "Operator contact address pending",
  contact: "Support and complaints",
  noticeTitle: "Please read carefully",
  notice: "Terms about payment, refunds, renewal, data transmission, AI limitations, liability and disputes directly affect your rights and are highlighted below. Registration does not purchase a membership. Accepting this agreement does not authorize recurring charges or replace any separate consent required for personal information processing.",
  contents: "Contents",
  offer: {
    title: "Current monthly offer (applies only after you opt in)",
    plan: "Service", merchant: "Merchant", amount: "Charge per period", perMonth: "month",
    period: "Billing cycle",
    periodValue: "Each calendar month on the corresponding sign-up date, or the last day of a shorter month. The authorization details and order you confirm with the payment provider state the first and subsequent charge dates.",
    method: "Payment method",
    methodValue: "Once authorized, the payment provider charges your approved payment method under the mandate. This offer does not apply to accounts without renewal or to other plans.",
  },
  sections: [
    {
      id: "scope",
      title: "Scope and acceptance",
      paragraphs: [
        { text: "“We” means the SomniQ Studio operator identified on this page; “you” means the individual or duly authorized organization using the service. These terms cover the SomniQ Studio website, accounts and related services. Separately licensed desktop components remain subject to their own licenses." },
        { text: "These terms govern the relevant service once you actively accept them during registration or another clearly identified step. Browsing alone does not consent to purchases, renewal or additional data processing. You may request an explanation of any term using the email on this page." },
        { text: "Orders and separately accepted service agreements may supplement the scope, price and delivery terms. Individually negotiated terms take precedence as provided by law. No page rule, supplementary agreement or translation excludes mandatory legal rights." },
      ],
    },
    {
      id: "services",
      title: "Services and availability",
      paragraphs: [
        { text: "SomniQ Studio is a local-first research workspace supporting ideas, literature, experiments, evidence analysis and writing. It may also provide model access, independent review, accounts, memberships and remote connections. Available features depend on the released version, your device, configuration and selected service." },
        { text: "Paid features, models, usage quota, service term and restrictions are those clearly disclosed and confirmed before purchase. Trial, experimental and planned features are subject to their stated status and are not automatically included in a purchase. We must honor specific service commitments made to you." },
      ],
    },
    {
      id: "account",
      title: "Eligibility and account security",
      paragraphs: [
        { text: "You must have the legal capacity needed to enter into and perform this agreement. Minors must use the service under a guardian’s guidance and obtain consent where required. Anyone acting for a school, laboratory or other organization must have the necessary authority." },
        { text: "Provide accurate, necessary registration details, keep contact information current, and protect passwords, API keys and device permissions. Do not sell or rent an account, or give unauthorized people access to an account or paired device, without permission." },
        { text: "If an account, key or paired device may be compromised, promptly change credentials, revoke permissions where appropriate and contact us. We will help investigate and take necessary protective measures. Responsibility for losses depends on fault, causation and applicable law; activity under your account does not automatically make you solely responsible." },
      ],
    },
    {
      id: "acceptable-use",
      title: "Lawful use and research integrity",
      paragraphs: [
        { text: "You must have the right to use submitted papers, code, data and other materials, and comply with applicable law, data licenses, confidentiality duties, research ethics and institutional or publication rules. Obtain necessary authorization before using another person’s personal information, unpublished research or restricted data." },
        { text: "Do not infringe others’ rights, distribute unlawful content, commit fraud, attack systems, gain unauthorized access, steal credentials, or maliciously bypass billing, access or security controls. Do not present fabricated citations, experimental data or review results as genuine research evidence. Conduct permitted by law or an open-source license is not further restricted by these terms." },
      ],
    },
    {
      id: "automation",
      title: "Automated tasks and permissions",
      paragraphs: [
        { text: "Automated tasks may read or change files, execute code, call models and connect to external services within the scope you set. Before starting, review the working directory, tool permissions, budget, stopping conditions and external service settings, and back up important files." },
        { text: "Continued execution and repeated reviews may incur multiple model calls or other charges. Permissions must stay within the scope you explicitly configure or confirm. Publishing, sending materials, payments, deletion and other consequential actions require the relevant product prompts and authorization. Starting a task does not consent to arbitrary external actions or unlimited charges.", important: true },
      ],
    },
    {
      id: "ai-output",
      title: "AI output and research judgment",
      paragraphs: [
        { text: "Model output and automated reviews may contain factual, citation, calculation or code errors, and may be incomplete, outdated or similar to someone else’s output. Independent Reviewer and revision workflows assist checking; they are not human expert endorsement and do not guarantee accuracy, originality, reproducibility, publication or acceptance.", important: true },
        { text: "Before adopting, publishing or submitting results, verify original sources, data provenance, experiment records, code and conclusions. Follow applicable rules for disclosing AI use and labeling generated content, and obtain appropriate professional judgment for medical, legal, financial or other consequential decisions. These cautions do not remove our legal responsibilities for product quality, safety or specific commitments." },
      ],
    },
    {
      id: "data",
      title: "Local data and personal information",
      paragraphs: [
        { text: "Local-first means project files and research records are primarily kept in your chosen local workspace. Online models, search, plugins, remote connections or collaboration may send relevant prompts, context, file excerpts or connection details to the selected service provider. Local storage does not mean all processing is offline. Check recipients and the scope of data before use.", important: true },
        { text: "Information necessary for accounts, security, billing and support may include registration and authentication details, device connections, usage, orders and fault records. Processing must be lawful, fair and necessary, with retention limited to what is needed. Applicable privacy notices must explain purposes, methods, categories, retention periods and ways to exercise your rights. This section does not replace a complete privacy notice." },
        { text: "Accepting this agreement does not authorize us to publish unpublished research, use it in marketing or train models unrelated to the requested service. Sensitive information, disclosure to other processors and cross-border transfers require applicable notices and safeguards, and separate consent where legally required. Review third parties’ privacy rules for their own processing." },
        { text: "Use the email on this page to request access, copies, correction or deletion of personal information, withdraw consent-based permissions or close an account. After necessary identity checks, we will handle requests according to law and explain the outcome. Refusing or withdrawing unnecessary processing consent must not prevent use of services that do not depend on it." },
      ],
    },
    {
      id: "intellectual-property",
      title: "Intellectual property and content permissions",
      paragraphs: [
        { text: "Using the service does not transfer your or the original rights holder’s rights in input materials. We process content only to the extent and for the period necessary to perform your requested service. Publication, promotion or other uses beyond that purpose require a separate lawful authorization." },
        { text: "Rights in generated content and permitted uses depend on applicable law, rights in the inputs and the selected third-party terms. Generating content for you does not give us ownership of your existing research. We do not guarantee that generated content is copyrightable, exclusive or free of third-party rights." },
        { text: "SomniQ Studio trademarks, interfaces and software in which we hold rights are protected by applicable law. Third-party and open-source components retain their respective licenses. These terms do not revoke, narrow or replace rights you already have under those licenses." },
      ],
    },
    {
      id: "billing",
      title: "Paid services, quota and orders",
      paragraphs: [
        { text: "Before purchase, the service, currency, price, billing unit, validity period and restrictions must be clear, including applicable quota consumption, reset, rollover and expiry rules. Confirmed and paid orders provide the agreed benefits. Membership benefits and consumable model quota are distinct." },
        { text: "Consumption may vary by model, input and output length and task runs, and is calculated using the billing rules accepted at purchase and actual usage records. Additional charges or purchases after quota runs out require appropriate authorization. We may not unilaterally add undisclosed fees or restrictions after purchase.", important: true },
        { text: "Price or plan changes must be announced beforehand and apply to new orders or duly confirmed later periods, without retroactively changing paid orders. Contact the email on this page for order, invoice, receipt or billing checks. We will provide invoices or receipts as legally required." },
      ],
    },
    {
      id: "auto-renewal",
      title: "Auto-renewal, payment authorization and cancellation",
      paragraphs: [
        { text: "This section forms part of the User Service Agreement and governs renewal and recurring payment authorization. Auto-renewal starts only when available, after you actively check acceptance of these renewal terms at checkout, select “Authorize auto-renewal” and complete payment-provider authorization. Registration, login, a one-time purchase, accepting these terms or checking a box alone does not complete payment enrollment or authorize recurring charges.", important: true },
        { text: "Before enrollment, we must clearly show the service, merchant, amount, cycle and cancellation method for you to review and freely choose. Valid payment-provider and server mandate records determine whether enrollment has succeeded. We must retain the accepted agreement version, authorization scope and mandate records." },
        { text: "During an active mandate, charges follow the amount and cycle you confirmed. Before every automatic charge we will prominently notify you of the time, amount and cancellation path. Price changes require prior notice and your confirmation before the new amount is charged. This section and your confirmed order and payment authorization define the mandate’s scope." },
        { text: "Subscribers can turn renewal off in Account → My membership → Auto-renewal, use a cancellation option supported by the payment provider, or request assistance by email. After successful cancellation, no further-period charges will be initiated and paid benefits remain until the current period ends. Charges already made follow the refund terms. Uninstalling, logging out or stopping use does not cancel renewal.", important: true },
        { text: "Auto-renewal management shows the mandate status, current benefit end date and next charge date and amount. If payment fails, actual orders and payment results determine whether benefits continue; unpaid or undelivered renewals must not be shown as successful. Report unauthorized or incorrect charges, or renewal charges after successful cancellation, to support@somni.chat with the order number and an explanation. We will check payment-provider records and handle corrections and refunds under Section 11." },
      ],
    },
    {
      id: "refunds",
      title: "Refunds and billing disputes",
      paragraphs: [
        { text: "For duplicate or unauthorized charges, incorrect amounts, undelivered paid benefits or our failure to provide an agreed service, you may request investigation, delivery or a refund as provided by law. We do not categorically exclude lawful refund or remedy rights merely because a service is digital or activated.", important: true },
        { text: "Refundable undelivered services are calculated from the amount actually paid, the period or verifiable usage actually delivered and rules disclosed before purchase, with the calculation explained to you. If a paid service cannot continue, unused prepayments must be handled as required by law. You will not be forced to accept coupons instead of a refund." },
        { text: "Provide an account identifier, order number, payment time, disputed amount and explanation; do not send passwords, verification codes or full bank card numbers. We will review both parties’ evidence and explain the decision, amount and expected timing. Refunds normally use the original payment method; any necessary alternative will be agreed with you and lawful. Statutory deadlines prevail. Refunds for properly delivered services depend on law and the terms confirmed at purchase." },
      ],
    },
    {
      id: "third-parties",
      title: "Third parties and remote connections",
      paragraphs: [
        { text: "External models, literature databases, payment providers, plugins and custom APIs may be supplied by third parties. Review their prices, permissions and privacy rules before enabling them. Services purchased directly from a third party are that party’s responsibility under its terms. Using third-party components does not release us from obligations for services we promise and charge you for." },
        { text: "Device pairing, tool connections and mutual assistance may allow an authorized device or participant to process selected content. Grant only necessary permissions and revoke them when no longer needed. Obtain permission before using another person’s account, materials or device. The relevant feature’s prompts describe the scope of that connection or sharing." },
      ],
    },
    {
      id: "availability-liability",
      title: "Service changes, interruptions and liability",
      paragraphs: [
        { text: "We will take reasonable measures to maintain availability and security. Planned maintenance, material feature changes or closure must be notified beforehand through appropriate channels. Where advance notice is impossible, such as an unexpected security incident or network failure, we must explain promptly and work to restore service or reduce the impact." },
        { text: "If changes materially affect purchased benefits, we must discuss continued performance, an alternative you accept or a refund for the undelivered portion. Force majeure responsibilities depend on actual impact and law, including notification and mitigation duties. An ordinary technical fault does not automatically exempt us from responsibility." },
        { text: "Liability for breach or infringement follows applicable law, taking account of fault, causation and loss. These terms do not exclude or limit liability that cannot lawfully be waived, including personal injury or property loss caused intentionally or by gross negligence, nor consumers’ rights to compensation, termination or other remedies.", important: true },
      ],
    },
    {
      id: "termination",
      title: "Account closure and termination",
      paragraphs: [
        { text: "You may stop using the service and request account closure by email. First back up records and review outstanding orders, refunds and renewal mandates. We must help resolve those matters and, during closure, check and address ongoing charge authorizations opened under the account and tell you the result." },
        { text: "Reasonable indications of unlawful use, serious breach or account compromise may lead to proportionate restrictions or suspension. Unless disclosure is legally prohibited or urgent action is necessary, we must explain the reason, scope and appeal method. After investigation, restrictions that are no longer necessary must be lifted promptly. You may submit evidence for review." },
        { text: "Closure or termination may end online benefits and account access. We must lawfully delete or anonymize unnecessary personal information and restrict the purpose and duration of any legally required retention. Closing an account does not automatically delete project files on your device; you manage local copies. Existing refund claims, lawful debts and obligations that legally survive remain effective.", important: true },
      ],
    },
    {
      id: "updates",
      title: "Updates and notices",
      paragraphs: [
        { text: "Revisions needed for changes in features, business or law will show a new version and update date on this page, with reasonable notice before taking effect through the website, app or your valid contact details. Material changes affecting fees, data use, liability or other important rights must be prominent and require renewed express consent where law requires it." },
        { text: "New terms do not automatically apply retroactively to completed transactions. Merely continuing to browse does not replace legally required consent. If you reject a material change, you may stop the affected service and address undelivered paid services under your terms and applicable law. Service notices and marketing must be distinguished; marketing must follow applicable consent and unsubscribe rules." },
      ],
    },
    {
      id: "law-contact",
      title: "Applicable law, disputes and contact",
      paragraphs: [
        { text: "Formation, validity, performance and disputes are determined under the law that legally applies. Services for mainland Chinese users must comply with applicable rules, including the Civil Code, Consumer Rights Protection Law and Personal Information Protection Law of the People’s Republic of China. Mandatory protections that apply in other regions are not excluded." },
        { text: "Send account, payment, personal information, infringement or agreement questions to support@somni.chat. After receiving necessary details, we will investigate, explain the outcome and provide a way to follow up. You may negotiate with us, complain to the relevant authority, seek mediation or bring proceedings before a court with jurisdiction. Arbitration requires a separate valid arbitration agreement. Negotiation is not a prerequisite to exercising statutory rights.", important: true },
        { text: "An invalid or unenforceable provision does not invalidate the rest. All language versions aim to express the same terms. Any ambiguity must be resolved under applicable law, the contracting circumstances and fairness, without reducing your legal rights because of a translation difference." },
      ],
    },
  ],
};

const es: UserServiceAgreementCopy = {
  title: "Acuerdo de servicio",
  intro: "Bienvenido a SomniQ Studio. Este acuerdo establece tus derechos y obligaciones y los del operador de SomniQ Studio al usar el sitio web, las cuentas, el espacio de investigación y los servicios en línea relacionados. Léelo antes de registrarte, comprar o activar un servicio y conserva las condiciones y los datos de tus pedidos.",
  version: "Versión del acuerdo",
  updated: "Última actualización",
  effective: "Aplicación",
  effectiveValue: "Se aplica desde tu aceptación expresa; las actualizaciones para usuarios existentes siguen la sección 15.",
  provider: "Proveedor del servicio",
  providerPending: "SomniQ Studio (nombre legal del operador pendiente)",
  address: "Dirección de contacto",
  addressPending: "Dirección de contacto del operador pendiente",
  contact: "Soporte y reclamaciones",
  noticeTitle: "Lee con atención",
  notice: "Las condiciones sobre pagos, reembolsos, renovación, transmisión de datos, límites de la IA, responsabilidad y disputas afectan directamente a tus derechos y se destacan más abajo. Registrarse no compra una membresía. Aceptar este acuerdo no autoriza cargos recurrentes ni sustituye el consentimiento separado exigido para tratar datos personales.",
  contents: "Índice",
  offer: {
    title: "Plan mensual actual (solo se aplica tras activarlo voluntariamente)",
    plan: "Servicio", merchant: "Comerciante", amount: "Importe por periodo", perMonth: "mes",
    period: "Ciclo de cobro",
    periodValue: "Cada mes natural en la fecha correspondiente a la contratación, o el último día de un mes más corto. Los datos de autorización y el pedido que confirmes con el proveedor de pagos indican las fechas del primer cobro y los siguientes.",
    method: "Forma de pago",
    methodValue: "Tras la autorización, el proveedor de pagos carga el medio autorizado conforme al mandato. Este plan no se aplica a cuentas sin renovación ni a otros planes.",
  },
  sections: [
    {
      id: "scope",
      title: "Ámbito y aceptación",
      paragraphs: [
        { text: "“Nosotros” se refiere al operador de SomniQ Studio identificado en esta página; “tú”, a la persona o entidad debidamente autorizada que usa el servicio. El acuerdo cubre el sitio web, las cuentas y los servicios relacionados. Los componentes de escritorio con licencia propia se rigen por esa licencia." },
        { text: "Estas condiciones rigen el servicio correspondiente cuando las aceptas activamente al registrarte o en otro paso claramente señalado. Navegar por el sitio no implica aceptar compras, renovaciones ni tratamientos adicionales de datos. Puedes solicitar aclaraciones mediante el correo de esta página." },
        { text: "Los pedidos y acuerdos específicos aceptados por separado pueden complementar el alcance, precio y prestación del servicio. Las condiciones negociadas individualmente prevalecen conforme a la ley. Ninguna regla del sitio, acuerdo complementario o traducción excluye derechos legales irrenunciables." },
      ],
    },
    {
      id: "services",
      title: "Servicios y disponibilidad",
      paragraphs: [
        { text: "SomniQ Studio es un espacio de investigación que prioriza el almacenamiento local y ayuda con ideas, bibliografía, experimentos, análisis de pruebas y escritura. También puede ofrecer acceso a modelos, revisión independiente, cuentas, membresías y conexiones remotas. Las funciones disponibles dependen de la versión publicada, el dispositivo, la configuración y el servicio elegido." },
        { text: "Las funciones de pago, modelos, cuotas, plazos y restricciones son los que se informan claramente y se confirman antes de comprar. Las funciones de prueba, experimentales o previstas se interpretan según su descripción y no se incluyen automáticamente en la compra. Debemos cumplir los compromisos concretos de servicio asumidos contigo." },
      ],
    },
    {
      id: "account",
      title: "Capacidad y seguridad de la cuenta",
      paragraphs: [
        { text: "Debes tener la capacidad legal necesaria para celebrar y cumplir este acuerdo. Los menores deben usar el servicio con orientación de su representante legal y obtener su consentimiento cuando sea necesario. Quien actúe en nombre de una escuela, laboratorio u otra entidad debe contar con autorización suficiente." },
        { text: "Proporciona datos de registro exactos y necesarios, mantén actualizados tus datos de contacto y protege contraseñas, claves API y permisos de dispositivos. Sin autorización, no vendas ni alquiles cuentas ni des acceso a personas no autorizadas a una cuenta o dispositivo vinculado." },
        { text: "Si sospechas que una cuenta, clave o dispositivo está comprometido, cambia las credenciales, revoca los permisos pertinentes y contáctanos cuanto antes. Ayudaremos a investigar y adoptar medidas de protección. La responsabilidad por las pérdidas depende de la culpa, la causalidad y la ley; que una acción se realice desde tu cuenta no te hace automáticamente responsable de todo el daño." },
      ],
    },
    {
      id: "acceptable-use",
      title: "Uso lícito e integridad académica",
      paragraphs: [
        { text: "Debes tener derecho a usar los artículos, código, datos y materiales aportados y respetar la legislación, licencias, confidencialidad, ética de investigación y normas institucionales o editoriales aplicables. Obtén los permisos necesarios antes de usar datos personales de terceros, investigaciones inéditas o datos restringidos." },
        { text: "No vulneres derechos ajenos, distribuyas contenido ilícito, cometas fraude, ataques sistemas, accedas sin autorización, robes credenciales ni eludas de forma maliciosa controles de cobro, acceso o seguridad. No presentes citas, datos experimentales o revisiones inventados como pruebas reales. Este acuerdo no restringe adicionalmente las conductas permitidas por ley o por una licencia de código abierto." },
      ],
    },
    {
      id: "automation",
      title: "Tareas automatizadas y permisos",
      paragraphs: [
        { text: "Las tareas automatizadas pueden leer o modificar archivos, ejecutar código, invocar modelos y conectarse a servicios externos dentro del alcance que establezcas. Antes de iniciarlas, revisa el directorio de trabajo, los permisos, presupuesto, condiciones de parada y servicios externos, y conserva copias de los archivos importantes." },
        { text: "La ejecución continua y las revisiones repetidas pueden generar múltiples llamadas a modelos u otros cargos. Los permisos deben limitarse a lo que configures o confirmes expresamente. Publicar, enviar materiales, pagar, eliminar y otras acciones relevantes deben seguir los avisos y autorizaciones correspondientes. Iniciar una tarea no autoriza acciones externas arbitrarias ni gastos ilimitados.", important: true },
      ],
    },
    {
      id: "ai-output",
      title: "Resultados de IA y criterio de investigación",
      paragraphs: [
        { text: "Los resultados y revisiones automatizadas pueden contener errores de hechos, citas, cálculos o código, estar incompletos o desactualizados, o parecerse a resultados ajenos. El Reviewer independiente y las revisiones ayudan a verificar, pero no son un aval de expertos humanos ni garantizan exactitud, originalidad, reproducibilidad, publicación o aceptación.", important: true },
        { text: "Antes de adoptar, publicar o presentar resultados, verifica fuentes originales, procedencia de datos, registros experimentales, código y conclusiones. Respeta las reglas aplicables sobre divulgación del uso de IA e identificación de contenido generado. Obtén criterio profesional adecuado en decisiones médicas, jurídicas, financieras u otras de gran impacto. Estas advertencias no eliminan nuestra responsabilidad legal por calidad, seguridad o compromisos concretos." },
      ],
    },
    {
      id: "data",
      title: "Datos locales e información personal",
      paragraphs: [
        { text: "Priorizar lo local significa que los archivos y registros de investigación se guardan principalmente en el espacio local que elijas. Los modelos en línea, búsquedas, complementos, conexiones remotas o colaboración pueden enviar instrucciones, contexto, fragmentos de archivos o datos de conexión al proveedor correspondiente. Guardar localmente no implica procesar todo sin conexión. Revisa los destinatarios y datos enviados antes de usar cada función.", important: true },
        { text: "Los datos necesarios para cuentas, seguridad, facturación y soporte pueden incluir registro, autenticación, conexiones de dispositivos, uso, pedidos e incidencias. El tratamiento debe ser lícito, legítimo y necesario, con conservación durante el tiempo mínimo necesario. Los avisos de privacidad aplicables deben explicar fines, métodos, categorías, plazos y vías para ejercer derechos. Esta sección no sustituye un aviso de privacidad completo." },
        { text: "Aceptar este acuerdo no nos autoriza a publicar investigaciones inéditas, usarlas en publicidad ni entrenar modelos ajenos al servicio solicitado. Los datos sensibles, la comunicación a otros responsables y las transferencias internacionales exigen los avisos y garantías aplicables y, cuando corresponda legalmente, consentimiento separado. Revisa las normas de privacidad de terceros para sus propios tratamientos." },
        { text: "Puedes solicitar acceso, copia, rectificación o supresión de datos, retirar autorizaciones basadas en consentimiento o cerrar tu cuenta mediante el correo de esta página. Tras la verificación de identidad necesaria, atenderemos la solicitud conforme a la ley y explicaremos el resultado. Rechazar o retirar un consentimiento no necesario no debe impedir usar servicios que no dependan de esos datos." },
      ],
    },
    {
      id: "intellectual-property",
      title: "Propiedad intelectual y permisos sobre contenido",
      paragraphs: [
        { text: "El uso del servicio no transfiere tus derechos ni los del titular original sobre los materiales aportados. Solo trataremos el contenido con el alcance y durante el tiempo necesarios para prestar el servicio solicitado. Su publicación, promoción u otros usos ajenos a ese fin requieren otra autorización legítima." },
        { text: "Los derechos sobre los resultados y sus usos permitidos dependen de la ley, los derechos sobre las entradas y las condiciones del proveedor elegido. Generar contenido para ti no nos otorga propiedad sobre tu investigación previa. No garantizamos que los resultados tengan derechos de autor, sean exclusivos o estén libres de derechos de terceros." },
        { text: "Las marcas, interfaces y programas de SomniQ Studio sobre los que tenemos derechos están protegidos por la ley. Los componentes de terceros y de código abierto mantienen sus respectivas licencias. Este acuerdo no revoca, reduce ni sustituye derechos adquiridos conforme a esas licencias." },
      ],
    },
    {
      id: "billing",
      title: "Servicios de pago, cuotas y pedidos",
      paragraphs: [
        { text: "Antes de comprar deben mostrarse el servicio, moneda, precio, unidad de cobro, vigencia y restricciones, incluidas las reglas de consumo, reinicio, acumulación o caducidad de cuotas. El pedido confirmado y pagado otorga los beneficios acordados. Los beneficios de membresía y las cuotas consumibles de modelos son conceptos distintos." },
        { text: "El consumo puede variar según el modelo, la longitud de entradas y salidas y el número de ejecuciones, y se calcula con las reglas aceptadas al comprar y los registros reales de uso. Los cargos o compras adicionales al agotarse la cuota requieren autorización. No podemos añadir unilateralmente después de la compra cargos o restricciones que no se hayan informado.", important: true },
        { text: "Los cambios de precios o planes deben anunciarse previamente y aplicarse a pedidos nuevos o periodos posteriores debidamente confirmados, sin modificar retroactivamente pedidos pagados. Escribe al correo de esta página para consultas de pedidos, facturas, comprobantes o cobros. Facilitaremos las facturas o comprobantes exigidos legalmente." },
      ],
    },
    {
      id: "auto-renewal",
      title: "Renovación automática, autorización de cobro y cancelación",
      paragraphs: [
        { text: "Esta sección forma parte del Acuerdo de servicio y regula la renovación y la autorización de cobros recurrentes. Solo se activa cuando está disponible, después de marcar expresamente la aceptación de estas condiciones de renovación al comprar, seleccionar “Autorizar renovación automática” y completar la autorización con el proveedor de pagos. Registrarse, iniciar sesión, comprar una vez, aceptar este acuerdo o marcar una casilla no completa por sí solo la contratación ni autoriza cobros recurrentes.", important: true },
        { text: "Antes de contratar debemos mostrar claramente el servicio, comerciante, importe, ciclo y método de cancelación para que los revises y elijas libremente. Los registros válidos del proveedor de pagos y del servidor determinan si la autorización está activa. Debemos conservar la versión aceptada, el alcance autorizado y los registros del mandato." },
        { text: "Mientras el mandato esté activo, se cobra el importe y ciclo confirmados. Antes de cada cargo notificaremos de forma destacada la fecha, importe y vía de cancelación. Un cambio de precio requiere aviso y confirmación previa del nuevo importe. Esta sección, el pedido y la autorización de pago que hayas confirmado delimitan el mandato." },
        { text: "Puedes desactivar la renovación en Cuenta → Mi membresía → Renovación automática, usar una vía de cancelación admitida por el proveedor de pagos o pedir ayuda por correo. Tras la cancelación efectiva no se iniciarán cargos de periodos posteriores y conservarás los beneficios pagados hasta el fin del periodo actual. Los cargos ya efectuados siguen las reglas de reembolso. Desinstalar, cerrar sesión o dejar de usar el servicio no cancela la renovación.", important: true },
        { text: "La gestión de renovación muestra el estado del mandato, el vencimiento de beneficios y la fecha e importe del próximo cobro. Si falla el pago, los pedidos y resultados reales determinan la continuidad de beneficios; no se debe mostrar como completada una renovación no pagada o no entregada. Comunica cargos no autorizados, incorrectos o posteriores a una cancelación efectiva a support@somni.chat con el número de pedido y una explicación. Revisaremos los registros del proveedor y tramitaremos correcciones y reembolsos conforme a la sección 11." },
      ],
    },
    {
      id: "refunds",
      title: "Reembolsos y discrepancias de facturación",
      paragraphs: [
        { text: "Ante cargos duplicados, no autorizados o incorrectos, beneficios pagados no entregados o incumplimiento nuestro del servicio acordado, puedes solicitar revisión, cumplimiento o reembolso conforme a la ley. No excluimos de forma general los derechos legales de reembolso o reparación porque el servicio sea digital o ya esté activado.", important: true },
        { text: "El reembolso de la parte no prestada que sea reembolsable se calcula según el importe realmente pagado, el periodo o uso verificable prestado y las reglas informadas antes de comprar, explicando el cálculo. Si el servicio de pago no puede continuar, los anticipos no consumidos deben tratarse conforme a la ley. No se impondrán cupones en sustitución del dinero a devolver." },
        { text: "Indica el identificador de cuenta, número de pedido, fecha de pago, importe discutido y problema; no envíes contraseñas, códigos de verificación ni números completos de tarjetas bancarias. Revisaremos las pruebas de ambas partes y explicaremos la decisión, importe y plazo previsto. Normalmente se devuelve al medio de pago original; si no es posible, acordaremos una alternativa lícita. Prevalecen los plazos legales. La devolución de servicios correctamente prestados depende de la ley y de las condiciones confirmadas al comprar." },
      ],
    },
    {
      id: "third-parties",
      title: "Servicios de terceros y conexiones remotas",
      paragraphs: [
        { text: "Los modelos externos, bases bibliográficas, proveedores de pago, complementos y API propias pueden proceder de terceros. Revisa precios, permisos y privacidad antes de activarlos. Los servicios comprados directamente a terceros son responsabilidad de estos conforme a sus condiciones. Usar componentes de terceros no nos libera de obligaciones por servicios que nosotros prometemos y cobramos." },
        { text: "La vinculación de dispositivos, conexión de herramientas y ayuda mutua pueden permitir que otro dispositivo o participante autorizado procese el contenido elegido. Concede solo los permisos necesarios y revócalos cuando dejen de serlo. Obtén autorización para usar cuentas, materiales o dispositivos ajenos. Los avisos de la función delimitan la conexión o el intercambio concreto." },
      ],
    },
    {
      id: "availability-liability",
      title: "Cambios, interrupciones y responsabilidad",
      paragraphs: [
        { text: "Adoptaremos medidas razonables para mantener la disponibilidad y seguridad. El mantenimiento planificado, cambios relevantes o cierre del servicio deben avisarse con antelación por canales apropiados. Cuando no sea posible, por ejemplo ante incidentes de seguridad o fallos de red imprevistos, debemos informar oportunamente e intentar restablecer el servicio o reducir su impacto." },
        { text: "Si un cambio afecta sustancialmente a beneficios comprados, debemos acordar contigo el cumplimiento, una alternativa que aceptes o el reembolso de la parte no prestada. Las responsabilidades por fuerza mayor dependen del impacto real y la ley, incluidas las obligaciones de aviso y mitigación. Un fallo técnico ordinario no exime automáticamente de responsabilidad." },
        { text: "La responsabilidad por incumplimiento o infracción sigue la ley, considerando culpa, causalidad y daños. Este acuerdo no excluye ni limita responsabilidades irrenunciables, incluidas lesiones personales o daños patrimoniales causados con intención o negligencia grave, ni derechos del consumidor a indemnización, resolución contractual u otros remedios.", important: true },
      ],
    },
    {
      id: "termination",
      title: "Cierre de cuenta y terminación",
      paragraphs: [
        { text: "Puedes dejar de usar el servicio y solicitar el cierre de cuenta por correo. Antes, guarda los registros necesarios y revisa pedidos pendientes, reembolsos y autorizaciones recurrentes. Debemos ayudarte a resolverlos y, al cerrar la cuenta, comprobar y gestionar las autorizaciones de cobro continuo vinculadas a ella e informarte del resultado." },
        { text: "Los indicios razonables de uso ilícito, incumplimiento grave o cuenta comprometida pueden justificar restricciones o suspensiones proporcionales. Salvo prohibición legal de informar o urgencia, debemos explicar causa, alcance y vía de reclamación. Tras la investigación, las restricciones innecesarias deben levantarse oportunamente. Puedes aportar pruebas para solicitar una revisión." },
        { text: "El cierre o terminación puede finalizar beneficios en línea y acceso a la cuenta. Debemos eliminar o anonimizar legalmente los datos personales innecesarios y limitar el uso y conservación de los registros legalmente exigidos. Cerrar la cuenta no elimina automáticamente archivos de tu dispositivo; tú gestionas las copias locales. Siguen vigentes las solicitudes de reembolso, deudas legítimas y obligaciones que subsistan legalmente.", important: true },
      ],
    },
    {
      id: "updates",
      title: "Actualizaciones y avisos",
      paragraphs: [
        { text: "Las revisiones necesarias por cambios funcionales, comerciales o legales indicarán una nueva versión y fecha en esta página y se comunicarán razonablemente antes de aplicarse mediante el sitio, la aplicación o tus datos de contacto válidos. Los cambios relevantes en precios, uso de datos, responsabilidad u otros derechos deben destacarse y requerir nueva aceptación expresa cuando lo exija la ley." },
        { text: "Las nuevas condiciones no se aplican automáticamente de forma retroactiva a transacciones completadas. Seguir navegando no sustituye un consentimiento legalmente exigido. Si rechazas un cambio relevante, puedes dejar el servicio afectado y resolver la parte pagada no prestada conforme al acuerdo y la ley. Los avisos de servicio deben distinguirse de la publicidad, que debe respetar las normas de consentimiento y baja aplicables." },
      ],
    },
    {
      id: "law-contact",
      title: "Ley aplicable, disputas y contacto",
      paragraphs: [
        { text: "La celebración, validez, cumplimiento y resolución de disputas se rigen por la legislación que resulte legalmente aplicable. Los servicios para usuarios de China continental deben respetar sus normas aplicables, incluidos el Código Civil, la Ley de Protección de los Derechos del Consumidor y la Ley de Protección de Información Personal de la República Popular China. No se excluyen las protecciones imperativas aplicables en otras regiones." },
        { text: "Envía consultas sobre cuentas, pagos, datos personales, infracciones o este acuerdo a support@somni.chat. Con la información necesaria, investigaremos, explicaremos el resultado y facilitaremos seguimiento. Puedes negociar, reclamar ante la autoridad correspondiente, solicitar mediación o acudir a un tribunal competente. El arbitraje requiere un acuerdo arbitral válido y separado. Negociar primero no es un requisito para ejercer derechos legales.", important: true },
        { text: "La invalidez o inaplicabilidad de una cláusula no invalida las demás. Las versiones lingüísticas buscan expresar lo mismo. Las ambigüedades se interpretarán conforme a la ley, las circunstancias de contratación y la equidad, sin reducir derechos legales por diferencias de traducción." },
      ],
    },
  ],
};

export const USER_SERVICE_AGREEMENT: Record<Lang, UserServiceAgreementCopy> = { zh, en, es };
