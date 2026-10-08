import type { CompanySettings, EmployeeProfile } from "./domain";
import defaultProfile from "./profiles/default-profile.json";
export const FINANCE_PROFILE: EmployeeProfile = {
  schemaVersion: 1, id: "finance", name: "财务工作台", jobTitle: "AI 财务专员", description: "保存原始单据，整理收支记录，依据公司要求形成可核对的报表。",
  fields: [
    { key: "date", label: "日期", type: "date", required: true, aliases: ["交易日期", "入账日期"] },
    { key: "direction", label: "收支", type: "select", required: true, aliases: ["方向", "类型"], options: ["收入", "支出"] },
    { key: "counterparty", label: "对方", type: "text", required: true, aliases: ["交易对方", "客户", "供应商"] },
    { key: "amount", label: "金额", type: "money", required: true, aliases: ["交易金额"] },
    { key: "invoice", label: "发票", type: "text", required: false, aliases: ["发票编号"] },
    { key: "category", label: "分类", type: "text", required: false, aliases: ["科目", "类别"] },
    { key: "contract", label: "合同", type: "text", required: false, aliases: ["合同编号"] },
    { key: "description", label: "说明", type: "text", required: false, aliases: ["摘要", "备注"] },
  ],
  agent: { prompt: "你是公司的财务助理。区分原始事实、人工整理和分析建议。引用原件ID与记录ID。缺少证据时说明缺口。仅形成建议，不作出纳付款、报税或法律结论。", skills: [{ id: "source-check", title: "单据核对", content: "先核对日期、交易对方、金额和发票关联。发现缺口时列出待核实事项。" }], sop: "1.核对来源。2.检查标准记录。3.按公司要求计算。4.生成报表。5.说明依据和待核实事项。", tools: [] },
  ui: { accentColor: "#315ee7", logoText: "财", css: ".role-summary { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit,minmax(160px,1fr)); } .role-summary h3 { font-size: 12px; } .role-summary p { font-size: 24px; font-weight: 600; }", html: '<section class="role-summary"><div><h3>收入</h3><p>{{income}}</p></div><div><h3>支出</h3><p>{{expense}}</p></div><div><h3>收支净额</h3><p>{{net}}</p></div></section>' },
};
export const HR_PROFILE: EmployeeProfile = {
  schemaVersion: 1, id: "hr", name: "人事工作台", jobTitle: "AI 人事专员", description: "沉淀员工资料，整理人事记录，形成有依据的人事摘要。",
  fields: [
    { key: "date", label: "日期", type: "date", required: true, aliases: ["入职日期", "记录日期"] },
    { key: "name", label: "姓名", type: "text", required: true, aliases: ["员工", "员工姓名"] },
    { key: "department", label: "部门", type: "text", required: true, aliases: ["组织"] },
    { key: "position", label: "岗位", type: "text", required: true, aliases: ["职位"] },
    { key: "status", label: "状态", type: "select", required: true, aliases: ["员工状态"], options: ["在职", "离职", "待入职"] },
    { key: "salary", label: "薪资", type: "money", required: false, aliases: ["工资"] },
    { key: "description", label: "说明", type: "text", required: false, aliases: ["备注"] },
  ],
  agent: { prompt: "你是公司的人事助理。引用资料依据，区分事实和建议。只处理用户提供的员工资料。缺少信息时询问用户，不推测个人敏感属性。", skills: [{ id: "hr-source-check", title: "人事资料核对", content: "核对姓名、部门、岗位、日期和状态。对缺失或冲突项形成待办。" }], sop: "1.核对资料。2.检查人员记录。3.整理变动。4.形成摘要。5.说明待核实事项。", tools: [] },
  ui: { accentColor: "#337767", logoText: "人", css: ".role-summary { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit,minmax(160px,1fr)); } .role-summary h3 { font-size: 12px; } .role-summary p { font-size: 24px; font-weight: 600; }", html: '<section class="role-summary"><div><h3>在职员工</h3><p>{{activeEmployees}}</p></div><div><h3>部门</h3><p>{{departmentCount}}</p></div></section>' },
};
export const DEFAULT_PROFILE = defaultProfile as EmployeeProfile;
export const DEFAULT_COMPANY: CompanySettings = { name: "示例公司", jurisdiction: "中国大陆", currency: "CNY", goals: "账目清楚、资料完整、建议有依据", policies: "Demo不执行付款、报税或正式人事决定。真实业务须由负责人核实。", reportingPeriod: "本月" };
