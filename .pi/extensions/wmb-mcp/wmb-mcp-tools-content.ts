import { callTool, textResult, type ToolDefinition } from './wmb-mcp-client.ts';

const authorityProperties = {
  taskId: { type: 'string' },
  grantId: { type: 'string' },
  workerLeaseId: { type: 'string' }
};
const authorityPayload = (params: Record<string, unknown>) => ({
  task_id: String(params.taskId ?? ''),
  grant_id: String(params.grantId ?? ''),
  worker_lease_id: params.workerLeaseId ? String(params.workerLeaseId) : undefined
});

const createCreativeBrief: ToolDefinition = {
  name: 'wmb_create_creative_brief', label: '创建创作简报',
  description: '从当前页或用户勾选的画布节点创建可编辑创作简报。evidenceNodeIds 只能来自本次 nodeIds。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      requestId: { type: 'string' },
      canvasId: { type: 'string' },
      nodeIds: { type: 'array', items: { type: 'string' } },
      selectionMode: { type: 'string', enum: ['current_page','selected'] },
      title: { type: 'string' },
      coreJudgment: { type: 'string' },
      whyNow: { type: 'string' },
      structure: { type: 'array', items: { type: 'string' } },
      evidenceNodeIds: { type: 'array', items: { type: 'string' } }
    },
    required: ['requestId', 'taskId', 'grantId', 'canvasId', 'nodeIds', 'selectionMode', 'title', 'coreJudgment', 'whyNow', 'structure', 'evidenceNodeIds'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('knowledge.creative_brief_create', {
      ...authorityPayload(params),
      request_id: String(params.requestId ?? ''),
      canvas_id: String(params.canvasId ?? ''),
      node_ids: params.nodeIds,
      selection_mode: params.selectionMode,
      title: String(params.title ?? ''),
      core_judgment: String(params.coreJudgment ?? ''),
      why_now: String(params.whyNow ?? ''),
      structure: params.structure,
      evidence_node_ids: params.evidenceNodeIds
    }));
  }
};

const updateCreativeBrief: ToolDefinition = {
  name: 'wmb_update_creative_brief', label: '更新创作简报',
  description: '按已有简报 ID 和 revision 更新内容。证据仍只能来自该简报的原始页面选择。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      requestId: { type: 'string' }, id: { type: 'string' }, expectedRevision: { type: 'number' },
      title: { type: 'string' }, coreJudgment: { type: 'string' }, whyNow: { type: 'string' },
      structure: { type: 'array', items: { type: 'string' } }, evidenceNodeIds: { type: 'array', items: { type: 'string' } }
    },
    required: ['requestId','taskId','grantId','id','expectedRevision','title','coreJudgment','whyNow','structure','evidenceNodeIds'],
    additionalProperties: false
  },
  async execute(_toolCallId,params){
    return textResult(await callTool('knowledge.creative_brief_update',{
      ...authorityPayload(params),
      request_id:String(params.requestId??''),id:String(params.id??''),expected_revision:Number(params.expectedRevision),
      title:String(params.title??''),core_judgment:String(params.coreJudgment??''),why_now:String(params.whyNow??''),
      structure:params.structure,evidence_node_ids:params.evidenceNodeIds
    }));
  }
};

const createProjectFromBrief: ToolDefinition = {
  name: 'wmb_create_project_from_brief', label: '从简报进入正文',
  description: '从已确认创作简报原子创建内容项目和首版正文，并关联所选真实资料。',
  parameters: { type:'object',properties:{requestId:{type:'string'},...authorityProperties,briefId:{type:'string'},expectedRevision:{type:'number'}},required:['requestId','taskId','grantId','briefId','expectedRevision'],additionalProperties:false },
  async execute(_toolCallId,params){
    return textResult(await callTool('knowledge.creative_brief_create_project',{request_id:String(params.requestId??''),...authorityPayload(params),brief_id:String(params.briefId??''),expected_revision:Number(params.expectedRevision)}));
  }
};

const getBriefLineage: ToolDefinition = {
  name: 'wmb_get_brief_lineage', label: '读取创作追溯链',
  description: '从简报读取内容项目、发布、指标、复盘和方法结论。',
  parameters: { type:'object',properties:{briefId:{type:'string'}},required:['briefId'],additionalProperties:false },
  async execute(_toolCallId,params){return textResult(await callTool('knowledge.creative_brief_lineage_get',{brief_id:String(params.briefId??'')}));}
};

const recordKnowledge: ToolDefinition = {
  name: 'wmb_record_knowledge', label: '沉淀资料主题',
  description: '把已保存资料归入稳定主题，并记录核验和管理状态。',
  parameters: { type: 'object', properties: { requestId: { type: 'string' }, ...authorityProperties, items: { type: 'array', items: { type: 'object', properties: {
    sourceId: { type: 'string' }, topic: { type: 'object' }, relation: { type: 'string' }, verificationStatus: { type: 'string' }, managementStatus: { type: 'string' }
  }, required: ['sourceId','topic'], additionalProperties: false } } }, required: ['requestId','taskId','grantId','items'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('knowledge.record_batch', { request_id: params.requestId, ...authorityPayload(params), items: params.items })); }
};

const proposeTopicMaintenance: ToolDefinition = {
  name: 'wmb_propose_topic_maintenance', label: '提交主题整理提案',
  description: '资料员提交 create/update/merge/archive/reassign 的冻结提案；不修改正式主题。Owner 只会在主题台账批准或驳回。',
  parameters: { type: 'object', properties: { requestId: { type: 'string' }, ...authorityProperties, supersedesProposalId: { type: 'string' }, title: { type: 'string' }, reason: { type: 'string' }, changes: { type: 'array', items: { type: 'object' } } }, required: ['requestId','taskId','grantId','title','reason','changes'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('knowledge.topic_maintenance_propose', { request_id: String(params.requestId ?? ''), ...authorityPayload(params), supersedes_proposal_id: params.supersedesProposalId, title: String(params.title ?? ''), reason: String(params.reason ?? ''), changes: params.changes })); }
};

const listTopicMaintenance: ToolDefinition = {
  name: 'wmb_list_topic_maintenance', label: '读取主题整理台账',
  description: '只读主题整理提案台账。主管用它呈报待批项；资料员用它核对状态。',
  parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('knowledge.topic_maintenance_list', { status: params.status, limit: params.limit, offset: params.offset })); }
};

const getTopicMaintenance: ToolDefinition = {
  name: 'wmb_get_topic_maintenance', label: '读取主题整理提案',
  description: '按 proposalId 读取冻结 before/after、准确关系清单与状态。只读。',
  parameters: { type: 'object', properties: { proposalId: { type: 'string' } }, required: ['proposalId'], additionalProperties: false },
  async execute(_toolCallId, params) { return textResult(await callTool('knowledge.topic_maintenance_get', { proposal_id: String(params.proposalId ?? '') })); }
};

const importProjectImage: ToolDefinition = {
  name: 'wmb_import_project_image',
  label: '导入 WMB 项目配图',
  description: '把 PNG/JPEG/WebP/GIF 的 base64 数据或受限 SVG 导入指定内容项目，返回 assetId 与可插入正文的 Markdown。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      requestId: { type: 'string' },
      projectId: { type: 'string' },
      contentBase64: { type: 'string' },
      svg: { type: 'string' },
      mimeType: { type: 'string' },
      fileName: { type: 'string' },
      alt: { type: 'string' }
    },
    required: ['requestId', 'taskId', 'grantId', 'projectId'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('content.import_image', {
      ...authorityPayload(params),
      request_id: String(params.requestId ?? ''),
      project_id: String(params.projectId ?? ''),
      bytes_base64: params.contentBase64 ? String(params.contentBase64) : undefined,
      svg_text: params.svg ? String(params.svg) : undefined,
      mime_type: params.mimeType ? String(params.mimeType) : undefined,
      file_name: params.fileName ? String(params.fileName) : undefined,
      alt: params.alt ? String(params.alt) : undefined
    }));
  }
};

const saveCoreVersion: ToolDefinition = {
  name: 'wmb_save_core_version',
  label: '保存 WMB 核心初稿',
  description: '通过 WMB MCP 为内容项目保存一个核心正文版本，并可同时更新项目标题。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      requestId: { type: 'string' },
      projectId: { type: 'string' },
      expectedRevision: { type: 'number' },
      title: { type: 'string' },
      body: { type: 'string' },
      mediaBindings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            assetId: { type: 'string' },
            occurrence: { type: 'number' },
            widthPreset: { type: 'string', enum: ['small', 'medium', 'large', 'full'] },
            align: { type: 'string', enum: ['left', 'center', 'right'] },
            caption: { type: ['string', 'null'] },
            linkUrl: { type: ['string', 'null'] },
            mediaKind: { type: 'string', enum: ['image', 'video', 'video_poster'] }
          },
          required: ['assetId', 'occurrence', 'widthPreset', 'align'],
          additionalProperties: false
        }
      }
    },
    required: ['requestId', 'taskId', 'grantId', 'projectId', 'expectedRevision', 'body'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('content.save_version', {
      ...authorityPayload(params),
      request_id: String(params.requestId ?? ''),
      project_id: String(params.projectId ?? ''),
      expected_revision: Number(params.expectedRevision),
      title: params.title ? String(params.title) : undefined,
      body: String(params.body ?? ''),
      media_bindings: Array.isArray(params.mediaBindings) ? params.mediaBindings.map((binding) => ({
        asset_id: String((binding as Record<string, unknown>).assetId ?? ''),
        occurrence: Number((binding as Record<string, unknown>).occurrence),
        width_preset: (binding as Record<string, unknown>).widthPreset,
        align: (binding as Record<string, unknown>).align,
        caption: (binding as Record<string, unknown>).caption,
        link_url: (binding as Record<string, unknown>).linkUrl,
        media_kind: (binding as Record<string, unknown>).mediaKind
      })) : undefined
    }));
  }
};

const savePlatformVersion: ToolDefinition = {
  name: 'wmb_save_platform_version',
  label: '保存 WMB 平台版本',
  description: '把 X、小红书、公众号或知乎文案保存为指定内容项目和核心版本下的平台版本；不执行最终发布。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      requestId: { type: 'string' },
      projectId: { type: 'string' },
      contentVersionId: { type: 'string' },
      platform: { type: 'string', enum: ['x', 'xiaohongshu', 'wechat', 'zhihu'] },
      format: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      versionId: { type: 'string' },
      expectedRevision: { type: 'number' }
    },
    required: ['requestId', 'taskId', 'grantId', 'projectId', 'contentVersionId', 'platform', 'format', 'body'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('content.save_version', {
      ...authorityPayload(params),
      request_id: String(params.requestId ?? ''),
      project_id: String(params.projectId ?? ''),
      content_version_id: String(params.contentVersionId ?? ''),
      platform: params.platform,
      format: String(params.format ?? ''),
      title: params.title ? String(params.title) : undefined,
      body: String(params.body ?? ''),
      version_id: params.versionId ? String(params.versionId) : undefined,
      expected_revision: typeof params.expectedRevision === 'number' ? params.expectedRevision : undefined
    }));
  }
};
const createContentProject: ToolDefinition = {
  name: 'wmb_create_content_project',
  label: '新建 WMB 内容项目',
  description: '为新主题、新榜单或新文章原子创建独立内容项目和首版正文。只有明确继续指定稿件时才使用保存核心版本工具。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      requestId: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      planItemId: { type: 'string' },
      sourceIds: { type: 'array', items: { type: 'string' } }
    },
    required: ['requestId', 'taskId', 'grantId', 'title', 'body'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('content.create', {
      ...authorityPayload(params),
      request_id: String(params.requestId ?? ''),
      title: String(params.title ?? ''),
      body: String(params.body ?? ''),
      plan_item_id: params.planItemId,
      source_ids: params.sourceIds
    }));
  }
};
const getContent: ToolDefinition = {
  name: 'wmb_get_content',
  label: '读取 WMB 创作项目',
  description: '通过 WMB MCP 读取内容项目与版本。保存后应传入 projectId 精确回读标题、版本号和正文。',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string' }
    },
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('content.get', {
      project_id: params.projectId ? String(params.projectId) : undefined
    }));
  }
};
const listContentProjects: ToolDefinition = {
  name: 'wmb_list_content_projects',
  label: '搜索 WMB 内容项目',
  description: '通过 WMB MCP 搜索内容项目摘要。每页最多 50 条，不读取历史正文。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      status: { type: 'string' },
      archived: { type: 'boolean' },
      limit: { type: 'number' },
      offset: { type: 'number' }
    },
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('content.list', {
      query: params.query ? String(params.query) : undefined,
      status: params.status ? String(params.status) : undefined,
      archived: params.archived === true,
      limit: typeof params.limit === 'number' ? params.limit : 50,
      offset: typeof params.offset === 'number' ? params.offset : 0
    }));
  }
};

const getMetrics: ToolDefinition = {
  name: 'wmb_get_metrics',
  label: '读取发布指标快照',
  description: '通过 WMB MCP 读取指定发布记录的指标快照。只读。',
  parameters: {
    type: 'object',
    properties: { publicationId: { type: 'string' } },
    required: ['publicationId'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('metrics.get', { publication_id: String(params.publicationId ?? '') }));
  }
};

const getReviews: ToolDefinition = {
  name: 'wmb_get_reviews',
  label: '读取复盘',
  description: '通过 WMB MCP 读取发布复盘与方法结论。只读。',
  parameters: {
    type: 'object',
    properties: {
      publicationId: { type: 'string' },
      finalOnly: { type: 'boolean' }
    },
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('reviews.get', {
      publication_id: params.publicationId ? String(params.publicationId) : undefined,
      final_only: params.finalOnly === true
    }));
  }
};

const saveReview: ToolDefinition = {
  name: 'wmb_save_review',
  label: '保存复盘',
  description: '通过 WMB MCP 保存或定稿复盘。最终复盘必须引用真实 metricSnapshotIds，并包含 Keep/Stop/Change。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      requestId: { type: 'string' },
      publicationId: { type: 'string' },
      metricSnapshotIds: { type: 'array', items: { type: 'string' } },
      keep: { type: 'array', items: { type: 'string' } },
      stop: { type: 'array', items: { type: 'string' } },
      change: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
      status: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' }
          },
          required: ['title', 'body'],
          additionalProperties: false
        }
      }
    },
    required: ['requestId', 'taskId', 'grantId', 'publicationId', 'metricSnapshotIds', 'keep', 'stop', 'change', 'status'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('reviews.save', {
      ...authorityPayload(params),
      request_id: String(params.requestId ?? ''),
      publication_id: String(params.publicationId ?? ''),
      metric_snapshot_ids: params.metricSnapshotIds,
      keep: params.keep,
      stop: params.stop,
      change: params.change,
      summary: params.summary ? String(params.summary) : undefined,
      status: params.status === 'final' ? 'final' : 'draft',
      findings: params.findings
    }));
  }
};

const getInvestigation: ToolDefinition = {
  name: 'wmb_get_investigation',
  label: '读取项目调查',
  description: '读取指定内容项目的专项调查状态、当前 revision、提纲版本、资料包和写作方向。',
  parameters: {
    type: 'object',
    properties: { projectId: { type: 'string' } },
    required: ['projectId'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    return textResult(await callTool('investigation.get', { project_id: String(params.projectId ?? '') }));
  }
};

const saveInvestigationOutline: ToolDefinition = {
  name: 'wmb_save_investigation_outline',
  label: '保存项目调查提纲',
  description: '主管为专项调查保存问题导向的完整提纲草稿。每次成功保存形成不可变新版本；不批准提纲、不派记者。',
  parameters: {
    type: 'object',
    properties: {
      ...authorityProperties,
      requestId: { type: 'string' },
      projectId: { type: 'string' },
      expectedRevision: { type: 'number' },
      outline: {
        type: 'object',
        properties: {
          scope: { type: 'string' },
          exclusions: { type: 'array', items: { type: 'string' } },
          known: { type: 'array', items: { type: 'string' } },
          hypotheses: { type: 'array', items: { type: 'string' } },
          questions: { type: 'array', items: { type: 'string' } },
          dimensions: { type: 'array', items: { type: 'string' } },
          materialRequirements: { type: 'array', items: { type: 'string' } },
          truthRisks: { type: 'array', items: { type: 'string' } },
          disconfirmingConditions: { type: 'array', items: { type: 'string' } },
          completionCriteria: { type: 'array', items: { type: 'string' } }
        },
        required: ['scope', 'exclusions', 'known', 'hypotheses', 'questions', 'dimensions', 'materialRequirements', 'truthRisks', 'disconfirmingConditions', 'completionCriteria'],
        additionalProperties: false
      }
    },
    required: ['requestId', 'taskId', 'grantId', 'projectId', 'expectedRevision', 'outline'],
    additionalProperties: false
  },
  async execute(_toolCallId, params) {
    const outline = params.outline as Record<string, unknown>;
    return textResult(await callTool('investigation.outline_save', {
      ...authorityPayload(params),
      request_id: String(params.requestId ?? ''),
      project_id: String(params.projectId ?? ''),
      expected_revision: Number(params.expectedRevision),
      outline: {
        scope: String(outline.scope ?? ''),
        exclusions: outline.exclusions,
        known: outline.known,
        hypotheses: outline.hypotheses,
        questions: outline.questions,
        dimensions: outline.dimensions,
        material_requirements: outline.materialRequirements,
        truth_risks: outline.truthRisks,
        disconfirming_conditions: outline.disconfirmingConditions,
        completion_criteria: outline.completionCriteria
      }
    }));
  }
};

export const contentTools = [createCreativeBrief, updateCreativeBrief, createProjectFromBrief, getBriefLineage, recordKnowledge, proposeTopicMaintenance, listTopicMaintenance, getTopicMaintenance, importProjectImage, saveCoreVersion, savePlatformVersion, createContentProject, getContent, listContentProjects, getInvestigation, saveInvestigationOutline, getMetrics, getReviews, saveReview];
