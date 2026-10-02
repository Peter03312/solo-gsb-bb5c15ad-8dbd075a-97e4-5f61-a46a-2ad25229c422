# 听证会逐字稿网页校订台

供听证会**记录员**与**复核员**（及**参与者**）使用的网页校订台：导入带段号的 UTF-8 逐字稿后，
记录员可在段内选定字符范围提交“替换文字 + 依据”的修订提议；复核员可采纳、驳回提议并发布。
发布形成不可变版本；因发布而过期的提议可由记录员**续提**（按逐次发布的修订把原选区换算到当前正文后重提）；
参与者可对原文范围留下异议引用，修订使被引文字消失时保留原文快照并提示重新定位。
**复核员还可按段号把段落设为保密或解除保密**：保密立即作用于当前及全部历史版本的参与者视图，
已发布版本、提议、异议与回应的原始记录均不改写（工作人员视图不受影响）。

**已登录用户可按段查看任一已发布版本正文连续片段的来源**：结果给出该版 Unicode 码点半开区间、
片段文字与来源（初始导入，或最后写入该片段的已发布提议编号与发布版本）；来源沿逐次发布的修订
几何重放得到，未触及文字保留原来源、替换/插入归本次提议、删除不占结果——不按同文搜索猜测。

**已登录用户可选择两个按时间先后排列的已发布版本，在网页按段对照端点正文的净变化**：服务端
按旧版→新版逐段给出每处净变化的**旧版/新版 Unicode 码点半开区间及对应文字**（替换/插入/删除），
并列出**促成每处变化的跨版已发布提议编号与发布版本**。修订链沿每次发布的坐标映射逐码点追踪
（重复文字只凭码点稳定身份对齐，**绝不靠同文搜索配对**）；中途改动最终撤销且两端文字相同的部分
不算变化，未变段不列变化。**参与者查看当前保密段时只见占位**，不获得该段文字、变化数量或提议信息，
解除保密后可重查；工作人员按现有权限查看。未导入、版本不存在或顺序不合法均明确拒绝；
查询只读，不改写版本、决议或保密状态。

**复核员可把当前正文恢复到任一更早的已发布历史版本**：先选择目标版本并填写**非空理由**预览
“当前正文 → 目标版”的**逐段净变化**（与跨版对照同一码点身份链口径，重复文字不靠同文搜索定位）；
确认时只接受**预览所见的当前版本与暂存状态**，且**仅空暂存可确认**。服务端按净变化逐段生成
**只覆盖净变化范围、关联目标版本的恢复提议**并立即采纳（未变化范围不产生提议，发布时不会被误算
为触及异议）；恢复提议仍须通过**现有发布前异议逐条回应门槛**才发布为**新的不可变版本**，
旧版、决议与原文快照一律不改写，正文来源、异议锚点、段关注通知均沿用正常发布规则。
预览后版本或暂存一旦变化，整次确认拒绝且**不留下任何部分提议**；无文档、目标版不存在、
目标就是当前版、两版正文相同或理由为空均明确拒绝。


**记录员可为本人“待复核”的修订提议上传依据文件**：提交原始文件名与预期 SHA-256，服务端只按内容
接收可识别的 PDF、PNG、JPEG、MP3、WAV（单件 ≤ 20 MB），并比对实际摘要；待复核期间可删除误传附件，
提议一经采纳、驳回、标记冲突或发布，附件集合即冻结，原文件随提议与历史决议保留、重启后仍可查阅，
续提的新提议不继承旧附件。复核员可查看全部附件，记录员只能查看本人上传，参与者不得获得任何附件
元数据、内容或下载地址（保密段与历史视图同样遵守）。

**任一登录用户可在已导入逐字稿中按段号关注或取消关注**：关注只影响**之后**的成功发布（不补发历史
通知）。成功发布时，若某关注段从**上一已发布版本到新版本**的正文存在**净变化**，即为每位关注者生成一条
站内通知（含**段号与两端版本号**）；**同版同段每人至多一条**——即使发布了提议，只要合版后该段正文未变
（如把文字替换成相同文字）就不通知。通知按发布时间倒序展示，用户可逐条标为已读；取消关注**不删除**
既有通知，重复标记已读不改变结果（幂等）。**参与者当前保密段的通知整体隐藏且不计入未读数**，解除保密
后恢复其原已读状态（通知行始终保留）；工作人员（记录员/复核员）按现有权限查看本人通知。
无文档、无效/未知段号、未登录或操作他人通知均明确拒绝；**失败发布不留下任何通知**。

技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 无构建浏览器原生前端。

---

## 一、快速启动（Docker Compose 一键启动）

前置要求：已安装 Docker（含 Compose v2）。

```bash
# （可选）复制环境变量文件并按需修改端口、种子账户密码
cp .env.example .env

# 构建并后台启动
docker compose up -d --build

# 查看日志
docker compose logs -f
```

启动后浏览器访问：

> **http://localhost:3000**  （如修改了 `HOST_PORT`，则为 `http://localhost:<HOST_PORT>`）

停止与清理：

```bash
docker compose down          # 停止（保留数据卷 hearing-revision-data）
docker compose down -v       # 停止并删除数据卷（将清空全部数据）
```

SQLite 数据库保存在命名卷 `hearing-revision-data`（容器内 `/data/hearing.sqlite`）中。
如需用宿主机目录，可把 compose 中的卷改为 `./data:/data`。

### 演示账户（首次启动自动初始化）

| 角色 | 用户名 | 密码 | 可执行操作 |
| --- | --- | --- | --- |
| 记录员 | `recorder` | `recorder123` | 导入逐字稿、提交修订提议、只读查看发布核对 |
| 复核员 | `reviewer` | `reviewer123` | 采纳/驳回提议、发布前回应被触及异议、发布新版本、重新定位异议、**恢复到历史版本**、**按段号保密/解除保密** |
| 参与者 | `participant` | `participant123` | 对原文范围提出异议、重新定位自己的异议（保密段除外）；保密段只看到占位 |

种子账户仅在数据库用户表为空时创建；可通过环境变量覆盖用户名与密码（见下文配置）。

---

## 二、本地直接运行（不用 Docker）

前置要求：Node.js ≥ 18（原生自带全局 `fetch`；开发环境为 Node 20）。better-sqlite3 为原生模块，
从 npm 安装时通常自动下载预编译二进制；若需源码编译，请准备 Python 3、make、g++。

```bash
npm install
npm start                 # 等价于 node src/server.js
```

然后访问 **http://localhost:3000**。

仅初始化数据库（建表 + 种子账户）不启动服务：

```bash
npm run init-db
```

运行测试（纯逻辑单元测试 + 启动临时服务的端到端测试）：

```bash
npm test
```

---

## 三、配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口（容器内）。宿主机端口用 compose 的 `HOST_PORT` 映射 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data`（本地）/ `/data`（容器） | SQLite 文件目录 |
| `DB_PATH` | `$DATA_DIR/hearing.sqlite` | 数据库文件完整路径 |
| `SESSION_TTL_MS` | `43200000` | 登录会话有效期（毫秒，默认 12 小时） |
| `SEED_RECORDIST_USER` / `SEED_RECORDIST_PASS` | `recorder` / `recorder123` | 记录员种子账户 |
| `SEED_REVIEWER_USER` / `SEED_REVIEWER_PASS` | `reviewer` / `reviewer123` | 复核员种子账户 |
| `SEED_PARTICIPANT_USER` / `SEED_PARTICIPANT_PASS` | `participant` / `participant123` | 参与者种子账户 |
| `ATTACHMENT_DIR` | `$DATA_DIR/attachments`（本地）/ `/data/attachments`（容器） | 依据文件落盘目录（相对存储名 `<提议号>/<随机名>.<后缀>`）；默认在数据卷内，随卷持久、重启可查 |
| `ATTACHMENT_MAX_BYTES` | `20971520`（20 MB） | 单件依据文件大小上限（字节）；超限返回 413 且不落盘 |

> 安全提示：演示使用 HTTP 与种子密码。生产部署请置于 HTTPS 反向代理之后，并修改全部种子密码；
> 种子账户仅在首次初始化（用户表为空）时生效。

---

## 四、使用流程

1. **记录员登录 → 导入逐字稿**
   - 粘贴 UTF-8 文本或选择 `.txt` 文件。行首段号支持 `12. 正文`、`12、正文`、`12 正文`；
     无段号的非空行自动顺延编号；段号重复会报错拒绝导入。
   - 导入即发布**不可变的第 1 版**。全场只允许导入一次，重复导入返回 409 且不改变状态。
2. **记录员在正文中拖选段内文字 → “提交修订提议”**，填写替换文字（空串表示删除，禁止换行跨段）与必填依据。
   - 提议**绑定提交时的已发布版本**（基版），并保存基版原文摘录快照。
3. **复核员**在右侧“提议”面板或正文标记上：
   - **采纳**：进入发布暂存区；**驳回**：可附原因，已采纳的也可驳回移出暂存区。
   - 采纳时若与暂存区已采纳修订**范围交叠**，或提议**基版已过期**，该提议被标记为“冲突”并写明原因，**不覆盖任何其他修订**。
4. **复核员发布（发布前异议回应门槛）**：
   - 发布前系统按异议**当前锚点**与暂存修订逐条核对：同段内**码点半开区间相交**即视为触及；
     **零长度修订（纯插入）的插入点落在引用范围 `[start,end)` 内**（点等于起点算、等于终点不算）也算触及。
   - 每条被触及的异议，复核员都必须**逐条回应**：填写**非空说明**，回应自动关联该异议、
     触及它的**已采纳提议**，以及回应时的**版本与暂存区状态**（指纹）。
   - 采纳/驳回提议、重新定位或新建异议后，发布时会**重新核对受影响集合与回应绑定**：
     暂存集合变化（`STAGE_CHANGED`）、锚点变化（`ANCHOR_MOVED`）、关联提议集合变化（`PROPOSALS_CHANGED`）
     都会使旧回应失效；发布前**临时新建的被触及异议**同样必须先回应。
     任一失效或缺失回应时发布被 **409 拒绝**（错误信息逐条列出异议与失效原因），
     **版本、提议及决议均不改变**。暂存修订**未触及任何异议**时，仍按原规则发布（空暂存仍拒绝重复发布）。
   - 可通过 `GET /api/publish-check`（或总览 `GET /api/booth` 的 `publishCheck`）随时查看
     待回应项与失效原因；网页发布条与“异议”面板同样展示待回应项、失效原因与回应入口，
     待回应未结清时发布按钮禁用。
   - 同一异议重新回应会取代未发布的旧回应（旧回应以 `superseded` 留痕保留）。
   - 发布成功后回应随版**只读归档**：在对应历史版本视图的“发布前异议回应”中展示，
     异议原文快照与既有重定位规则保持不变。
   - 同一基版上互不重叠的采纳结果按段合并，形成**不可变新版本**；发布后所有仍待复核的提议一律
     标记为“基版已过期”冲突，需由记录员基于新版本重新提交（可手工重提，也可用下述“续提”）。
   可随时切换“发布预览”查看合并效果。
5. **续提（基版已过期提议的换算重提）**：记录员可对**本人**因发布被标为“基版已过期”的冲突提议，
   在提议卡片或详情弹窗中点击“续提到当前版本…”发起**续提预览**；非本人或非此类冲突（如范围交叠）的提议会被拒绝。
   - 系统按从原基版到当前版**逐次发布的修订**，把原段内码点半开选区换算到当前正文，
     显示目标选区、当前摘录、原替换文字与依据（纯几何换算，**不凭同文搜索猜测位置**）。
   - 仅当该选区**未被中途修订触及**（零长度选区则其插入点未被任何修订区间触及），
     且换算目标**不与当前已采纳（暂存区）提议交叠**时，确认后生成**关联原提议的新待复核提议**
     （沿用原替换文字与依据，绑定当前版本为新基版）。
   - 中途修订触及选区/插入点、目标段缺失、或预览之后版本/暂存区发生变化时，确认被拒绝并提示
     **重新预览**或在当前正文**手工选区提交**；原冲突提议、决议与历史版本均保持可追溯，
     新提议沿用现有复核与发布规则。
   - **续提生成的新提议不自动继承旧附件**：旧附件随原冲突提议冻结保留，新提议需在其待复核期间另行上传。
6. **依据附件（记录员上传，本轮新增）**：记录员可在**本人、且状态为“待复核(pending)”**的提议详情中
   点击“上传依据文件”（或调用 HTTP API），为修订补充证据材料。
   - 仅接收**内容可识别的 PDF、PNG、JPEG、MP3、WAV**（按文件头/魔术字节嗅探，改后缀名或伪造
     `Content-Type` 无效），**单件不超过 20 MB**；提交时须给出**原始文件名**（仅作展示）与
     **预期 SHA-256**（浏览器端自动计算）；服务端重新计算实际摘要，**摘要不符（422）、超限（413）、
     类型不可识别/空文件/缺头（400）一律拒绝，不产生可见的半成品或孤儿记录**（先写临时文件再原子改名，
     失败立即清理）。
   - **删除误传附件**仅限提议仍待复核、且为上传者本人；删除同时移除元数据与磁盘文件。
   - **冻结规则**：提议一经**采纳、驳回、标记冲突或发布**，附件集合立即冻结——只可查看/下载/在网页预览，
     不能再增删；冻结判定在数据库事务内以**最终提议状态**复查（并发上传与复核以最终状态为准）。
   - **保留与继承**：原文件随提议及历史决议永久保留，**重启后仍可查阅**（默认落在数据目录
     `$DATA_DIR/attachments/`，随数据卷持久）；**续提生成的新提议不自动继承**旧附件。
   - **权限**：复核员可查看/下载**全部**附件；记录员只能查看/下载**本人上传**（他人附件不可见、
     下载/删除统一返回 404，不暴露存在性）；**参与者不得获得附件元数据、内容或下载地址**——
     `GET /api/booth` 的提议与 `GET /api/versions/:id` 的决议中均不含附件字段，下载接口返回 404；
     **保密段及历史视图也遵守同一权限**。网页对授权用户展示原名、类型、大小、上传者、时间与
     预期/实际 SHA-256 校验信息，图片可预览、音频可在线播放、PDF 可新标签打开。
7. **异议引用**：任何登录用户都可拖选原文范围提出异议，系统保存被引原文快照。
   - 之后发布的修订若与引用范围相交，引用不会自动改指新文字：该异议在新版本中显示
     **“待重新定位”**警示，原文快照继续保留；可由提出者或复核员在当前版本上手动重新定位并留痕。
8. **版本查看**：“版本”面板可只读查看任一历史版本的**正文、决议（采纳/驳回/冲突/续提/发布留痕）、
   异议与发布前异议回应**；历史版本内容不随后续发布改变。工作人员在相关决议中还能看到该提议
   **已冻结的依据附件**（权限同上：记录员仅本人、复核员全部）。
   - **按段查看正文来源（本轮新增）**：在当前正文或任一历史版本视图中，每段段尾点击“来源”，
     即可查看该版该段每个**连续片段**的 **Unicode 码点半开区间 `[start,end)`、片段文字与来源**。
     来源只有两类：**初始导入**（`"source":"initial"`）或**最后写入该片段的已发布提议编号与发布版本**
     （`"source":"proposal","proposalId":N,"versionId":V`）。来源由初始导入正文出发，
     沿 v2、v3……逐次发布的修订**逐码点几何重放**得到：未被触及的码点保留原来源；替换或插入的码点
     归本次提议（即使替换文字与原文完全相同也算重写，不按同文搜索猜测）；删除不产出码点、不占结果；
     同版多处修订、相邻边界与后续再次改写均按修订坐标判定。相邻同来源码点合并为一个连续片段，
     片段区间首尾相接、按序拼接恰好还原该版该段正文（emoji 等增补平面字符按 1 个码点计）。
   - 参与者对**当前保密段**在**所有版本**都看不到来源：接口返回 403，不获得片段文字、提议编号或来源；
     解除保密后按现有权限立即恢复。未导入（无文档）、未知版本或未知段号一律明确拒绝（409/404），
     不生成虚构来源。
   - **跨版净变化对照（本轮新增）**：在右侧“版本”面板顶部“跨版净变化对照”选择**旧版 → 新版**
     （两个按时间先后排列的已发布版本，`from < to`）并点“对照”，弹窗按段并排展示两版正文并高亮
     净变化，同时表格逐处列出**旧版半开区间/旧文字、新版半开区间/新文字、变化类型（替换/插入/删除）
     与促成该变化的跨版已发布提议编号·发布版本**。净变化由初始导入出发沿 v2、v3……逐次发布的修订
     **逐码点坐标映射**，给每个码点一个稳定身份，再对两端身份序列做对齐得到：重复文字（如删掉某字、
     又在段尾另插同一个字）只凭身份几何对齐，**不按同文搜索配成“移动”**；**中途改动最终撤销、两端
     文字相同的原位整块不计净变化**（但对照到中途版本仍可见那次真实改动，历史不可变）；**未变段
     `changeCount=0`**，仍下发两版正文供并排展开查看。区间为各自版本该段的 Unicode 码点半开区间，
     纯插入的旧区间、纯删除的新区间为零长度（插入/删除点）。
     **保密与只读**：参与者对**当前保密段**只见占位（`secret:true`），不获得该段两版正文、变化数量、
     变化或提议信息，顶层计数也不含该段；**解除保密后重新对照即恢复**，工作人员（记录员/复核员）
     始终按现有权限看到全部内容。未导入返回 409、版本不存在 404、`from ≥ to` 或参数缺失返回
     409/400；对照是只读查询，**不改写任何版本、决议或保密状态**。
9. **段级保密（复核员）**：复核员在正文段尾点击“设为保密/解除保密”（或调用 HTTP API），
   也可在工具栏“保密留痕”中查看全部变更。
   - **保密以段号为准**：段号在各版本间不变（发布只改段内正文），一次设置**立即作用于当前及全部历史版本**的
     参与者视图；**不改写**任何已发布版本、提议、异议、回应与决议原始记录——工作人员（记录员/复核员）始终看到全部内容。
   - **参与者只看到保密占位**（“该段已按段号保密”），不获得该段正文、发布暂存预览、提议及其替换文字与依据、
     异议原文与说明、发布前回应和决议；**发布核对**（`GET /api/publish-check` 及总览中的 `publishCheck`）
     **仅供记录员与复核员查看**，参与者也**看不到版本备注**。
   - 参与者**不得在保密段新建异议，也不得把异议重新定位进/出保密段**（服务端 403 拒绝）；
     **保密前已存在的相关异议不删除、不改动**，仍由工作人员按原发布规则处理
     （采纳修订、发布前逐条回应、发布后待重新定位、由复核员重新定位等），仅对参与者隐藏。
   - **解除保密后**参与者重新可见该段正文与相关记录；保密/解除均在数据库事务中执行，
     留痕**操作人、时间与前后状态**（`public → secret` / `secret → public`）。
   - 失败均明确拒绝且不改变状态：未知段号 → 404；重复保密/对未保密段解除 → 409；非复核员操作 → 403。
10. **段关注与发布通知（本轮新增，任一登录用户）**：在左侧正文每段段尾点击 **“☆ 关注”/“★ 已关注”**
    即可关注或取消关注（参与者视角的保密占位旁同样可关注）。
    - **关注只影响之后的成功发布**：关注前的版本变化不补发通知。
    - 复核员每次**成功发布**后，若关注段从上一已发布版本到新版本的**正文有净变化**（逐码点不等；
      仅“把文字替换成相同文字”的同文重写不算变化），该段的每位关注者得到一条站内通知，
      通知给出**段号与两端版本号（v旧 → v新）**；**同版同段每人至多一条**。
    - 右侧新增 **“通知”** 标签（角标为未读数）：通知**按发布时间倒序**排列，可逐条**标为已读**
      （重复标记幂等，不改变首次已读时间），点“查看净变化对照”直接打开两端版本的按段对照。
    - **取消关注不删除**既有通知；通知是否存在只取决于“发布时是否仍关注、且该段正文有净变化”。
    - **保密互动**：参与者对**当前保密段**的通知**整体隐藏**（列表不返回、不计未读数、也不能标记）；
      之后**解除保密，通知重新出现并恢复原已读状态**（未读仍是未读、已读仍是已读）。
      工作人员的通知与校订流程始终不受保密影响。
    - 失败均明确拒绝：未导入（无文档）→ 409；段号非整数 → 400；未知段号 → 404；未登录 → 401；
      把**他人通知**标为已读 → 403；通知不存在（含对参与者隐藏的保密段通知）→ 404。
      通知只在发布数据库事务内生成，**发布失败（如发布前异议回应未结清）整体回滚，不留通知、不产生版本**。
11. **恢复到历史版本（本轮新增，复核员）**：在右侧“版本”面板任一**非当前**版本卡片点击
    **“恢复到此版本…”**，填写**非空恢复理由**后先发起**恢复预览**；或调用
    `POST /api/restore/:targetVersion/preview`。
    - **预览口径**：弹窗按段并排展示**当前版（将删改，红）与目标版（恢复后，绿）**正文，
      表格逐处列出当前区间/文字、目标区间/文字、**恢复动作（插入/删除/替换）与促成该段差异的
      跨版已发布提议**；只列出有净变化的段，给出变化段数与净变化总处数，并显示当前暂存是否为空。
      净变化与跨版对照完全同口径：沿修订链逐码点身份对齐，**重复文字绝不靠同文搜索配对**，
      中途改动最终撤销、两端相同的整块不计。预览是只读操作，不改写任何状态。
    - **确认口径**：点“确认恢复”（或调用 `POST /api/restore/confirm` 回传预览 `token`）后，
      服务端在同一事务内重新核对：**当前版本与预览一致、暂存区为空且指纹一致、理由与净变化摘要
      未被篡改**；随后按每处净变化在**当前版坐标**生成一条**恢复提议**（`[now.start,now.end)`
      替换为目标版文字；纯删除/纯插入对应零长度区间），其依据为“恢复到 vN：<理由>”，
      **关联目标版本**（`restore_target_version_id`）并**直接采纳**进入发布暂存区。
      同段多条恢复提议在当前版坐标严格互不重叠；未变化范围不产生提议。事务末尾还有合版自检：
      应用全部恢复编辑后的正文必须与目标版快照逐码点一致，否则整批回滚。
    - **发布仍走现有门槛**：恢复提议只是“已采纳提议”，发布前被其触及的异议仍须复核员
      **逐条非空回应**（未变化范围上的异议不会被触及——触及判定只看恢复编辑的码点区间）；
      发布形成**新的不可变版本**（版本号继续递增，不覆盖任何旧版）。发布时其余待复核提议照常
      标记基版过期、异议锚点照常映射、段关注净变化通知照常生成；恢复回的文字在“来源”中归属
      **恢复提议与新版本**（不归初始导入），跨版对照仍保留中途各版的真实改动历史。
      **旧版本、历史决议与异议原文快照从不改写**；恢复动作在决议流留痕（`restore` 类型，
      记录批次、目标版本、段与区间），历史版本只读视图与提议卡片展示“↺ 恢复提议（关联 vN）”。
    - **失败均明确拒绝且不留部分提议**：无文档 → 409 `NO_DOCUMENT`；目标版号非整数 → 400；
      目标版不存在 → 404 `NOT_FOUND`；目标就是当前版 → 409 `RESTORE_SAME_VERSION`；
      两版正文逐码点相同 → 409 `RESTORE_NO_NET_CHANGES`；理由为空 → 400；
      非复核员（记录员/参与者/未登录）→ 403/401；**确认时暂存区非空** → 409 `STAGE_NOT_EMPTY`；
      预览后已发布新版本/暂存变化/令牌被篡改 → 409 `STALE_PREVIEW`/`STALE_STAGE`；
      缺少令牌 → 400。任一失败整事务回滚，暂存区与提议集合恢复到确认前状态。
    - 网页在版本卡片提供入口、弹窗呈现恢复预览与关联信息，发布条显示“恢复提议（目标版本 vN）”
      与待回应异议状态，提议卡片/详情显示关联目标版本（可点开只读查看该版）。

所有失败场景（无权操作、非法字符范围、重复发布、重复导入、重复采纳/重定位等）均返回明确的
HTTP 状态码与中文原因，且在数据库事务中执行——失败即回滚，不改变任何状态。

### 字符范围口径

范围按 **Unicode 码点**计偏移、半开区间 `[start, end)`（前后端一致，emoji 等增补平面字符按 1 个字符计），
仅允许在同一段落内选择；`[0,2)` 与 `[2,4)` 视为不重叠，可无缝相接。

---

## 五、HTTP API 摘要

会话采用 HttpOnly Cookie（`POST /api/login` 返回 `session`）。除登录、静态资源外均需登录。

| 方法与路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/login` / `POST /api/logout` | 全部 | 登录 / 退出 |
| `GET /api/me` | 全部 | 当前用户 |
| `GET /api/booth` | 登录用户 | 当前版本正文、暂存区、提议、异议、版本列表；含 `secretSegs` 保密段号集合与 `followedSegs` 本人关注段号集合，参与者视角下保密段返回占位并过滤相关记录（不含 `publishCheck` 与版本备注） |
| `POST /api/doc/import` | 记录员 | 导入逐字稿（仅一次），形成 v1 |
| `POST /api/proposals` | 记录员 | 提交提议 `{seg,start,end,replacement,basis}` |
| `POST /api/proposals/:id/adopt` | 复核员 | 采纳；交叠/过期则返回冲突标记与原因 |
| `POST /api/proposals/:id/reject` | 复核员 | 驳回（可含 `reason`） |
| `POST /api/proposals/:id/rebase-preview` | 记录员（本人） | 续提预览：把“基版已过期”冲突提议的选区逐版换算到当前正文，返回目标选区/摘录/原替换文字与依据及确认凭证 |
| `POST /api/proposals/:id/rebase-confirm` | 记录员（本人） | 确认续提 `{token}`：校验凭证（版本与暂存区未变、选区未被触及、不与暂存区交叠）后生成关联原提议的新待复核提议 |
| `POST /api/restore/:targetVersion/preview` | 复核员 | **恢复预览**：`{reason}` 非空；按修订链码点身份逐段返回当前版→目标版的净变化（当前/目标半开区间与文字、恢复动作、促成提议）与确认凭证。无文档 409、目标版不存在 404、目标即当前 409、两版正文相同 409、理由空 400；只读不改写状态 |
| `POST /api/restore/confirm` | 复核员 | **确认恢复** `{token}`：仅空暂存可确认；校验预览所见版本/暂存/理由/净变化摘要后，按净变化生成**关联目标版本**的恢复提议并直接采纳（整批事务，失败不留部分提议）。随后仍经异议逐条回应门槛发布为新不可变版本；暂存非空 409 `STAGE_NOT_EMPTY`、预览后版本/暂存变化或令牌篡改 409、缺令牌 400 |
| `POST /api/publish` | 复核员 | 合并暂存修订并发布新版本 |
| `POST /api/objections` | 登录用户 | 对原文范围提出异议 `{seg,start,end,note}` |
| `POST /api/objections/:id/relocate` | 提出者或复核员 | 对“待重新定位”的异议手动重定位 |
| `POST /api/objections/:id/respond` | 复核员 | 发布前对被暂存修订触及的异议填写非空回应 `{note}`；自动关联异议、触及提议、当前版本与暂存指纹。未被触及时返回 409 |
| `GET /api/publish-check` | 记录员、复核员 | 只读发布前核对（参与者 403）：受影响异议、每条关联提议、回应绑定状态与失效原因（`missing` / `STAGE_CHANGED` / `ANCHOR_MOVED` / `PROPOSALS_CHANGED`）；工作人员的 `GET /api/booth` 在 `publishCheck` 字段返回相同内容 |
| `POST /api/segments/:seg/secret` | 复核员 | **按段号设为保密**。未知段号 404、重复设置 409；留痕操作人/时间/前后状态，立即作用于当前及全部历史版本的参与者视图 |
| `POST /api/segments/:seg/unsecret` | 复核员 | **解除保密**。未知段号 404、该段未保密时 409；解除后参与者重新可见 |
| `GET /api/secret-logs` | 复核员 | 保密变更留痕列表（段号、动作、前后状态、操作人、时间） |
| `GET /api/versions/:id` | 登录用户 | 只读查看不可变版本（正文/决议/异议/发布前异议回应）；参与者视角下保密段仅返回占位且按段过滤决议、异议、回应与版本备注 |
| `GET /api/versions/:id/sources/:seg` | 登录用户 | **按段查看版本 `:id` 第 `:seg` 段的正文连续片段来源**：返回该段正文与 `fragments`（每片含码点半开区间 `[start,end)`、`text` 与来源：`initial` 初始导入，或 `proposalId`+`versionId` 最后写入该片的已发布提议/发布版本）。来源沿逐次发布的修订几何重放，不按同文猜测；未导入 409、未知版本/段号 404；参与者查看当前保密段 403，解除保密后恢复 |
| `GET /api/diff?from=A&to=B` | 登录用户 | **跨版净变化对照**：`A`、`B` 为两个按时间先后排列的已发布版本（要求 `A < B`）。按段返回旧版/新版正文与 `changes`（每处含 `kind` 替换/插入/删除、旧版半开区间与文字 `old`、新版半开区间与文字 `now`、促成该变化的跨版已发布提议 `contributors:[{proposalId,versionId}]`）。修订链沿每次发布的坐标映射逐码点追踪，重复文字不按同文搜索配对；中途改动最终撤销且两端相同的部分不计、未变段 `changeCount=0`。参与者对当前保密段只见占位（无正文/变化/提议），解除保密后可重查，工作人员按现有权限查看。未导入 409、版本不存在 404、顺序不合法（`from≥to`）409、参数缺失 400；只读不改写状态 |
| `POST /api/proposals/:id/attachments` | 记录员（本人） | **上传依据文件**：请求体为文件原始字节（非 JSON），请求头 `X-Attachment-Filename`（原始文件名，UTF-8 百分号编码，仅展示）、`X-Attachment-SHA256`（64 位十六进制预期摘要）。仅对本人**待复核**提议；内容须可识别为 PDF/PNG/JPEG/MP3/WAV 且 ≤ 20 MB，实际摘要须与预期一致。201 返回附件元数据；提议不存在 404、非本人/非记录员 403、已冻结 409、空文件/缺头/类型不可识别 400、摘要不符 422、超限 413；失败不留半成品或孤儿文件 |
| `DELETE /api/attachments/:aid` | 记录员（上传者本人） | **删除误传附件**（事务内复查最终状态）：仅待复核提议可删；非本人统一 404（不暴露存在性），冻结后 409；元数据与磁盘文件一并移除 |
| `GET /api/attachments/:aid/download` | 记录员（本人上传）/复核员 | **下载依据文件**：`Content-Type` 按内容嗅探结果、`X-Attachment-SHA256` 为实际摘要、`Content-Disposition` 含 RFC 5987 中文原始文件名。复核员可下载全部，记录员仅限本人上传；**参与者及未授权者一律 404**（不获得内容或地址），未登录 401 |
| `POST /api/segments/:seg/follow` | 登录用户 | **按段号关注**。仅作用于之后的成功发布（不补发历史通知）；幂等，重复关注返回当前关注状态。无文档 409、段号非整数 400、未知段号 404、未登录 401 |
| `POST /api/segments/:seg/unfollow` | 登录用户 | **取消关注**（幂等）；**不删除**既有通知。失败码同上 |
| `GET /api/notifications` | 登录用户 | **本人通知列表**：按发布时间（新版本号）倒序、同版按段号倒序；返回 `{notifications:[{id,seg,fromVersionId,toVersionId,read,readAt,createdAt}], unreadCount}`。仅含本人通知；**参与者当前保密段的通知整体隐藏且不计 `unreadCount`**，解除保密后恢复；工作人员按现有权限查看。无文档返回空列表 |
| `POST /api/notifications/:id/read` | 登录用户 | **逐条标为已读**（幂等：重复标记不改变首次 `readAt`）。仅本人；**操作他人通知 403**；通知不存在或对当前参与者隐藏（当前保密段）404；未登录 401 |

### 发布前异议回应调用示例（curl）

```bash
# 1) 复核员登录，保存会话 Cookie
curl -i -c /tmp/rev.cookie -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"reviewer","password":"reviewer123"}'

# 2) 发布前核对：查看被暂存修订触及的异议、关联提议与回应状态
curl -s -b /tmp/rev.cookie http://localhost:3000/api/publish-check
# {
#   "versionId": 2,
#   "stageFp": "[[5,2,9,18,\"3月上旬\"]]",
#   "items": [
#     { "objectionId": 1, "seg": 2, "start": 9, "end": 18,
#       "anchorStatus": "active", "quotedText": "2024年3月2日",
#       "proposalIds": [5], "response": null, "satisfied": false } ] }
# （已回应但失效时 response 为 {"id":..,"note":..,"invalidReason":"…","invalidCode":"STAGE_CHANGED"}）

# 3) 逐条回应：非空说明；关联异议/提议/版本/暂存状态由服务端绑定
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/objections/1/respond \
  -H 'Content-Type: application/json' \
  -d '{"note":"经核对原始录音，日期确应为3月上旬，异议不影响本次修订，准予发布并留痕。"}'
# {"ok":true,"id":1,"objectionId":1,"versionId":2,"proposalIds":[5]}

# 4) 回应未结清时发布 → 409 OBJECTION_RESPONSES_REQUIRED，错误逐条列出异议与失效原因；
#    全部 satisfied 后发布成功，回应随新版本只读归档
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/publish \
  -H 'Content-Type: application/json' -d '{"note":"第二次修订"}'
# {"ok":true,"versionId":3}
```

> 触及口径：非零长度修订与异议当前锚点的半开区间相交即触及；零长度修订（纯插入）的插入点
> 满足 `anchor.start ≤ 插入点 < anchor.end` 即触及（点在引用起点算、在终点不算）。
> 采纳/驳回提议、重新定位异议后须重新核对；重新回应同一异议会取代其未发布旧回应（旧回应留痕）。

### 段级保密调用示例（curl）

```bash
# 1) 复核员登录，保存会话 Cookie
curl -i -c /tmp/rev.cookie -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"reviewer","password":"reviewer123"}'

# 2) 把第 7 段设为保密（立即作用于当前及全部历史版本的参与者视图）
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/segments/7/secret
# {"ok":true,"seg":7,"secret":true,"logId":12,"previousState":"public","newState":"secret"}

# 3) 参与者总览/历史版本中该段只返回占位，且无该段提议、异议、发布核对与版本备注
curl -s -b /tmp/par.cookie http://localhost:3000/api/booth
#   {"seg":7,"text":"该段已按段号保密","secret":true}  // 不出现真实正文、stage.replacement、proposals/objections 记录
curl -s -b /tmp/par.cookie http://localhost:3000/api/versions/1
#   历史版本 v1 的第 7 段同样为占位（版本原始记录未被改写，工作人员仍可看到真实内容）

# 4) 失败场景：明确拒绝且不改变状态
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/segments/999/secret
#   404 {"error":"未知段号：当前版本 v3 中不存在第 999 段，无法设为保密","code":"NOT_FOUND"}
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/segments/7/secret
#   409 {"error":"第 7 段已是保密状态，请勿重复设置","code":"ALREADY_SECRET"}
# 参与者尝试保密（或访问发布核对/保密留痕）→ 403 FORBIDDEN
curl -s -b /tmp/par.cookie -X POST http://localhost:3000/api/segments/7/secret
#   403 {"error":"无权操作：参与者（participant）不能执行该操作，需要 reviewer 身份",…}

# 5) 参与者在保密段新建/重新定位异议 → 403，状态不变
curl -s -b /tmp/par.cookie -X POST http://localhost:3000/api/objections \
  -H 'Content-Type: application/json' -d '{"seg":7,"start":0,"end":2,"note":"x"}'
#   403 {"error":"第 7 段已保密：参与者不得在保密段新建异议","code":"FORBIDDEN"}

# 6) 解除保密：参与者重新可见；工作人员的校订与发布流程始终不受影响
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/segments/7/unsecret
# {"ok":true,"seg":7,"secret":false,"logId":13,"previousState":"secret","newState":"public"}

# 7) 查看保密变更留痕（仅复核员）
curl -s -b /tmp/rev.cookie http://localhost:3000/api/secret-logs
# {"logs":[{"id":13,"seg":7,"action":"declassify","previous_state":"secret","new_state":"public",
#           "created_at":"2026-10-01 01:02:03","actor_name":"复核员","actor_user":"reviewer"}, …]}
```

> 说明：保密状态以段号为键全局保存，不复制到每个版本——因此无需迁移历史数据，
> 设置/解除即时对所有版本生效；`versions.segments_json`、`proposals`、`objections`、
> `objection_responses` 等原始记录从不被更新，过滤只发生在面向参与者的视图层。

### 正文来源调用示例（curl）

```bash
# 1) 任一登录用户（记录员/复核员/参与者均可，保密段除外）查看某版某段的连续片段来源
curl -s -b /tmp/rec.cookie http://localhost:3000/api/versions/3/sources/2
# {
#   "versionId": 3, "seg": 2, "secret": false,
#   "text": "申请人张三称：我于2024年3月上旬收到通知。",
#   "length": 27,
#   "fragments": [
#     { "start": 0, "end": 6, "text": "申请人张三称", "source": "initial" },
#     { "start": 6, "end": 15, "text": "：我于2024", "source": "initial" },
#     { "start": 15, "end": 19, "text": "3月上旬",
#       "source": "proposal", "proposalId": 5, "versionId": 3 },
#     { "start": 19, "end": 27, "text": "收到通知。", "source": "initial" }
#   ] }
# - source=initial：该片段自初始导入起未被任何已发布修订触及；
# - source=proposal：最后写入该片段的是已发布提议 #5（随 v3 发布）；
# - 区间为该版第2段的 Unicode 码点半开区间，片段首尾相接、拼接恰好还原 text；
#   纯删除不产生片段；把原文改成相同文字也归当次提议（不按同文搜索猜测）。

# 2) v1（初始导入）查看：整段一个 initial 片段
curl -s -b /tmp/par.cookie http://localhost:3000/api/versions/1/sources/2
#   {"versionId":1,"seg":2, ... "fragments":[{"start":0,"end":N,"text":"…","source":"initial"}]}

# 3) 失败场景：明确拒绝，不生成虚构来源
curl -s -b /tmp/rec.cookie http://localhost:3000/api/versions/999/sources/1
#   404 {"error":"版本 v999 不存在，无法查看来源","code":"NOT_FOUND"}
curl -s -b /tmp/rec.cookie http://localhost:3000/api/versions/1/sources/999
#   404 {"error":"未知段号：版本 v1 中不存在第 999 段，无法查看来源","code":"NOT_FOUND"}
curl -s -b /tmp/par.cookie http://localhost:3000/api/versions/1/sources/7
#   403 {"error":"第 7 段已保密：参与者不得查看该段正文片段与来源","code":"FORBIDDEN"}
# （解除保密后同一请求立即恢复正常；工作人员始终可查看）
```

> 重放口径：以 v1 该段原文为起点，逐版本取 `status='published' AND published_version_id=v AND seg=?`
> 的提议（坐标为各自发布时的基版坐标），按发布合版相同的次序做 `prefix + 替换码点 + suffix` 切片：
> 每个新码点打上“提议编号 + 发布版本”标签，其余码点沿用旧标签。因此同版多处修订、`[0,2)`/`[2,4)`
> 相邻边界、零长度纯插入与后续再次改写都能精确定位；服务端还会校验重放结果与该版不可变快照逐码点
> 一致，不一致（数据损坏）时报错而非编造来源。

### 跨版净变化对照调用示例（curl）

```bash
# 1) 任一登录用户（记录员/复核员/参与者均可，当前保密段对参与者返回占位）
#    选择两个按时间先后排列的已发布版本：旧版 from、新版 to（from < to）
curl -s -b /tmp/rec.cookie "http://localhost:3000/api/diff?from=1&to=3"
# {
#   "from": { "versionId": 1, "note": "初始导入", "createdAt": "…" },
#   "to":   { "versionId": 3, "note": "第二次修订", "createdAt": "…" },
#   "changedSegments": 1, "changeCount": 1,
#   "segments": [
#     { "seg": 1, "secret": false,
#       "oldText": "申请人张三称：我于2024年3月1日收到通知。", "oldLength": 26,
#       "newText": "申请人张三称：我于2024年3月上旬收到通知。", "newLength": 27,
#       "changeCount": 1,
#       "changes": [
#         { "kind": "replace",
#           "old": { "start": 15, "end": 19, "text": "3月1日" },
#           "now": { "start": 15, "end": 19, "text": "3月上旬" },
#           "contributors": [ { "proposalId": 5, "versionId": 3 } ] } ] },
#     { "seg": 2, "secret": false, "oldText": "…", "newText": "…", "changeCount": 0, "changes": [] }
#   ] }
#
# - kind：replace 替换 | insert 纯插入（old 为零长度插入点）| delete 纯删除（now 为零长度删除点）；
# - old/now 的 start/end 分别是旧版/新版该段的 Unicode 码点半开区间（emoji 按 1 码点）；
# - contributors：促成该处净变化的跨版“已发布提议编号 + 发布版本”，按发布版本、提议号升序，
#   只含 (from,to] 区间内的发布；未变段 changeCount=0（仍下发 oldText/newText 供并排展示）。

# 2) 中途改动最终撤销、两端文字相同：不计净变化（但对照到中途版本仍可见那次改动）
#    v1「李四辩」→ v2「某某辩」(提议#8) → v3「李四辩」(提议#9)
curl -s -b /tmp/rec.cookie "http://localhost:3000/api/diff?from=1&to=3"
#   该段 changeCount: 0（changes: []，oldText===newText，中途撤销不算净变化）
curl -s -b /tmp/rec.cookie "http://localhost:3000/api/diff?from=1&to=2"
#   该段 1 处 replace：old「李四辩」→ now「某某辩」，contributors: [#8@v2]

# 3) 重复文字不靠搜索配对：删掉旧字、又在段尾另插同一个字，报为两处独立变化
#    v1「甲乙丙」→ v2「乙甲丙」之类位置不同的删除+插入，即便含相同字也分别列出 delete 与 insert，
#    不会配成“移动”或无变化。

# 4) 参与者与当前保密段：该段只见占位，不获得文字、变化数量或提议信息（计数也不含该段）
curl -s -b /tmp/par.cookie "http://localhost:3000/api/diff?from=1&to=3"
#   保密段对应元素：{ "seg": 7, "secret": true, "text": "该段已按段号保密", "changes": [], "changeCount": 0 }
#   顶层 changedSegments/changeCount 均不计入保密段；解除保密后重新请求即恢复全部信息。
#   工作人员（记录员/复核员）始终看到该段真实两版正文、changes 与 contributors。

# 5) 失败场景：明确拒绝，且为只读（不改写版本、决议或保密状态）
curl -s -b /tmp/rec.cookie "http://localhost:3000/api/diff?from=3&to=2"
#   409 {"error":"版本顺序不合法：旧版 v3 必须早于新版 v2（要求 from < to，且均为已发布版本）","code":"BAD_VERSION_ORDER"}
curl -s -b /tmp/rec.cookie "http://localhost:3000/api/diff?from=1&to=999"
#   404 {"error":"新版 v999 不存在，无法对照","code":"NOT_FOUND"}
curl -s -b /tmp/rec.cookie "http://localhost:3000/api/diff"            # 未导入另为 409 NO_DOCUMENT
#   400 {"error":"缺少有效的版本号：须提供整数 from 与 to（按时间先后排列的两个已发布版本）","code":"BAD_REQUEST"}
```

> 网页操作：右侧“版本”面板顶部选择旧版、新版后点“对照”，弹窗按段并排展示两版正文
> （旧版红色删除底纹、新版绿色插入底纹，纯插入/删除点以 `▏` 标出），表格逐处给出两侧半开区间、
> 文字、变化类型与促成提议；未变段可点“展开对照”并排查看，当前保密段对参与者只显示占位。

> 对照口径：服务端从 v1 该段原文出发，逐版本（v2…`to`）按发布合版相同的切片次序重放，给每个码点
> 一个**稳定身份**（初始码点 `i:N`；修订插入码点 `e:提议:版本:序号`），再对旧版/新版两版的身份序列
> 做 LCS 对齐。只有身份相同才是“同一码点未变”，重复文字绝不按内容搜索配对；同处（同一对齐间隙）
> 整块替换且新旧文字逐位相同视为原位撤销、不计净变化，位置不同的删除与插入分别列出。促成提议由
> 并查集沿“每次修订删除的身份 ∪ 插入的身份”归并，取变化端点身份关联到的、区间 `(from,to]` 内的全部
> 已发布提议；服务端另校验重放结果与两端不可变快照逐码点一致，不一致（数据损坏）时报错而非编造。

### 恢复到历史版本调用示例（curl）

```bash
# 1) 复核员登录
curl -i -c /tmp/rev.cookie -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"reviewer","password":"reviewer123"}'

# 2) 预览“当前 v5 恢复到 v1”的逐段净变化（理由必填；只读，不改写状态）
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/restore/1/preview \
  -H 'Content-Type: application/json' \
  -d '{"reason":"经核对录音，v3/v4 的日期与姓名修订均系误改，恢复初始表述"}'
# {
#   "currentVersion": { "id": 5, "note": "…", "createdAt": "…" },
#   "targetVersion":  { "id": 1, "note": "初始导入", "createdAt": "…" },
#   "reason": "经核对录音……",
#   "changedSegments": 1, "changeCount": 2,
#   "stageEmpty": true, "stageCount": 0,
#   "segments": [
#     { "seg": 1,
#       "currentText": "申请人张三丰称：我于2024年3月上旬收到通知。", "currentLength": 28,
#       "targetText":  "申请人张三称：我于2024年3月1日收到通知。",   "targetLength": 27,
#       "changeCount": 2,
#       "changes": [
#         { "kind": "replace", "restoreKind": "replace",
#           "old": { "start": 3, "end": 5, "text": "张三" },
#           "now": { "start": 3, "end": 6, "text": "张三丰" },
#           "contributors": [ { "proposalId": 2, "versionId": 3 } ] },
#         { "kind": "replace", "restoreKind": "replace",
#           "old": { "start": 15, "end": 19, "text": "3月1日" },
#           "now": { "start": 16, "end": 20, "text": "3月上旬" },
#           "contributors": [ { "proposalId": 1, "versionId": 2 },
#                             { "proposalId": 3, "versionId": 4 } ] } ] } ],
#   "token": { "v": 5, "t": 1, "stg": "[]", "reason": "经核对录音……", "digest": "…(sha256)" } }
#
# - restoreKind：恢复要执行的动作（insert 插入 / delete 删除 / replace 替换）；
# - old/now：目标版/当前版该段的 Unicode 码点半开区间与文字（纯插入/删除为零长度区间）；
# - contributors：促成该段差异的跨版已发布提议（仅信息展示，恢复提议本身只关联目标版本）。

# 3) 确认恢复：回传预览 token（仅空暂存可确认；整批事务，失败不留部分提议）
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/restore/confirm \
  -H 'Content-Type: application/json' \
  -d '{"token":{"v":5,"t":1,"stg":"[]","reason":"经核对录音……","digest":"…"}}'
# 201 {
#   "ok": true, "batchId": "9f1e…",
#   "currentVersionId": 5, "targetVersionId": 1, "reason": "经核对录音……",
#   "changedSegments": 1, "changeCount": 2,
#   "proposalCount": 2, "proposalIds": [8, 9],
#   "proposals": [ {"id":8,"seg":1,"start":16,"end":20,"replacement":"3月1日"},
#                  {"id":9,"seg":1,"start":3,"end":6,"replacement":"张三"} ] }
# 提议 #8/#9 已采纳进入暂存区，依据为“恢复到 v1：经核对录音……”，关联目标版本 v1。

# 4) 仍须按现有门槛回应被触及异议（未变化范围上的异议不在核对结果中），再发布
curl -s -b /tmp/rev.cookie http://localhost:3000/api/publish-check
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/objections/2/respond \
  -H 'Content-Type: application/json' -d '{"note":"恢复经核对原始录音，准予发布并留痕。"}'
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/publish \
  -H 'Content-Type: application/json' -d '{"note":"恢复到 v1 的发布"}'
# 201 {"ok":true,"versionId":6}   ← 新的不可变版本；v1~v5 快照与决议均不改写

# 5) 失败场景：均明确拒绝，且不留下任何部分提议
#    目标版不存在 404；目标就是当前版 409 RESTORE_SAME_VERSION；
#    两版正文逐码点相同 409 RESTORE_NO_NET_CHANGES；理由为空 400；
#    确认时暂存区非空 409 STAGE_NOT_EMPTY；
#    预览后发布了新版本/暂存变化/token 被篡改 409 STALE_PREVIEW / STALE_STAGE；
#    记录员、参与者调用 → 403 FORBIDDEN；未登录 → 401。
```

> 网页操作：在右侧“版本”面板的非当前版本卡片点“恢复到此版本…”，填写非空理由后预览，
> 弹窗并排高亮当前/目标正文并逐处列出恢复动作与促成提议；暂存非空时确认按钮禁用。
> 确认后发布条标注“恢复提议（目标版本 vN）”并按常规显示待回应异议；提议卡片带
> “↺ 恢复提议：关联目标版本 vN”，历史版本决议中可查 `恢复提议` 留痕。

> 恢复口径：净变化与 `GET /api/diff` 完全同源（`text.diffLineage`），方向取 target→current，
> 再把每处净变化反译为当前版坐标上的恢复编辑 `[now.start,now.end) → old.text`，
> 故“只覆盖净变化范围、重复文字不靠同文搜索、两端相同整块不计”由码点身份对齐天然保证；
> 确认事务重算全部编辑并校验合版结果与目标版快照逐码点一致，不一致即整批回滚。

### 依据附件调用示例（curl）

```bash
# 0) 记录员登录
curl -i -c /tmp/rec.cookie -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"recorder","password":"recorder123"}'

# 1) 计算文件的预期 SHA-256（小写十六进制），并对中文原始文件名做百分号编码
SHA=$(sha256sum /tmp/现场录音.wav | awk '{print $1}')
NAME=$(node -e "console.log(encodeURIComponent('现场录音 00-12.wav'))")

# 2) 上传：请求体是文件原始字节（--data-binary），不要包成 JSON
curl -s -b /tmp/rec.cookie -X POST http://localhost:3000/api/proposals/7/attachments \
  -H 'Content-Type: application/octet-stream' \
  -H "X-Attachment-Filename: ${NAME}" \
  -H "X-Attachment-SHA256: ${SHA}" \
  --data-binary @/tmp/现场录音.wav
# 201 {
#   "ok": true,
#   "attachment": {
#     "id": 3, "proposalId": 7, "displayName": "现场录音 00-12.wav",
#     "mediaType": "wav", "mime": "audio/wav", "size": 182340,
#     "expectedSha256": "9f1e…", "actualSha256": "9f1e…", "sha256Matched": true,
#     "frozen": false,
#     "uploadedBy": { "id": 1, "name": "记录员", "username": "recorder" },
#     "uploadedAt": "2026-10-01 07:40:11",
#     "url": "/api/attachments/3/download" } }

# 3) 总览/历史视图中的附件元数据（工作人员；参与者的提议/决议中不含 attachments 字段）
curl -s -b /tmp/rec.cookie http://localhost:3000/api/booth
#   proposals[].attachments = [{ id, displayName, mediaType, size,
#     expectedSha256, actualSha256, sha256Matched, frozen, uploadedBy, uploadedAt, url }]

# 4) 下载（浏览器可直接打开该地址：图片内联、音频带播放器、PDF 新标签查看）
curl -s -b /tmp/rec.cookie -D - -o /tmp/dl.wav http://localhost:3000/api/attachments/3/download
#   HTTP/1.1 200
#   Content-Type: audio/wav
#   X-Attachment-SHA256: 9f1e…（实际摘要，可再次校验）
#   Content-Disposition: inline; filename="…wav"; filename*=UTF-8''%E7%8E%B0%E5%9C%BA…
sha256sum /tmp/dl.wav   # 与上面的 actualSha256 一致

# 5) 待复核期间删除误传附件（仅上传者本人；事务内以最终提议状态为准）
curl -s -b /tmp/rec.cookie -X DELETE http://localhost:3000/api/attachments/3
# {"ok":true}

# 6) 失败场景：均明确报错，且不留半成品/孤儿文件
#   - 摘要不符：422 SHA256_MISMATCH（错误信息给出实际摘要）
#   - 超过 20 MB：413 FILE_TOO_LARGE
#   - 文本/GIF 等不支持内容（即使改名为 .pdf）：400 UNSUPPORTED_MEDIA_TYPE
#   - 缺 X-Attachment-Filename / X-Attachment-SHA256、空文件、把请求体发成 JSON：400
#   - 提议已采纳/驳回/冲突/发布：409 PROPOSAL_FROZEN
#   - 为他人提议上传：403；删除/下载非本人附件（记录员视角）：404（不暴露存在性）
#   - 参与者下载任意附件：404；未登录：401
```

> 网页操作：在右侧“提议”卡片点击打开提议详情，记录员在本人**待复核**提议的“依据附件”区选择文件即可
> （浏览器自动计算 SHA-256）；音频可直接播放，图片可点“预览”，PDF/图片链接可新标签打开。
> 附件冻结后上传与删除入口消失，仅保留下载与校验信息；历史版本只读视图的相关决议中同样列出冻结附件。

### 段关注与发布通知调用示例（curl）

```bash
# 1) 任一登录用户（记录员/复核员/参与者均可）登录
curl -i -c /tmp/me.cookie -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"participant","password":"participant123"}'

# 2) 关注第 2 段（幂等；关注只影响之后的成功发布，不补发历史通知）
curl -s -b /tmp/me.cookie -X POST http://localhost:3000/api/segments/2/follow
# {"ok":true,"seg":2,"following":true}

# 3) 复核员成功发布后（关注段正文有净变化才通知；同文重写不通知），查看本人通知（按发布时间倒序）
curl -s -b /tmp/me.cookie http://localhost:3000/api/notifications
# {
#   "notifications": [
#     { "id": 3, "seg": 2, "fromVersionId": 1, "toVersionId": 3,
#       "read": false, "readAt": null, "createdAt": "2026-10-02 08:10:33" },
#     { "id": 1, "seg": 4, "fromVersionId": 1, "toVersionId": 2,
#       "read": true, "readAt": "2026-10-02 07:55:02", "createdAt": "2026-10-02 07:40:11" } ],
#   "unreadCount": 1 }
# - 每条通知含段号 seg 与两端版本号 fromVersionId→toVersionId（上一已发布版本 → 本次新版本）；
# - 同版同段每人至多一条；取消关注不影响既有通知；
# - 参与者当前保密段的通知不在列表中、也不计入 unreadCount（解除保密后恢复原已读状态）。

# 4) 逐条标为已读（重复标记幂等，readAt 保留首次标记时间）
curl -s -b /tmp/me.cookie -X POST http://localhost:3000/api/notifications/3/read
# {"ok":true,"id":3,"read":true}

# 5) 取消关注（幂等；既有通知保留）
curl -s -b /tmp/me.cookie -X POST http://localhost:3000/api/segments/2/unfollow
# {"ok":true,"seg":2,"following":false}

# 6) 失败场景：均明确拒绝
#    无文档关注：409 NO_DOCUMENT；段号非整数：400；未知段号：404；未登录：401
curl -s -b /tmp/me.cookie -X POST http://localhost:3000/api/segments/999/follow
#   404 {"error":"未知段号：当前版本 v3 中不存在第 999 段，无法关注或取消关注","code":"NOT_FOUND"}
#    操作他人通知：403 FORBIDDEN
curl -s -b /tmp/other.cookie -X POST http://localhost:3000/api/notifications/3/read
#   403 {"error":"无权操作：不能将他人的通知标为已读，只能操作自己的通知","code":"FORBIDDEN"}
#    通知不存在 / 参与者操作其当前保密段的通知：404 NOT_FOUND
```

> 生成口径：通知在**发布数据库事务**内写入——先得到合版后的新不可变版本，再逐段比较
> “上一已发布版本正文 vs 新版本正文”是否逐码点不同；只有净变化段的**发布时仍关注**用户各得一条
> （`UNIQUE(user_id, to_version_id, seg)` 兜底同版同段每人至多一条）。发布任一步骤失败
> （如发布前异议回应未结清、空暂存重复发布）整个事务回滚：**版本、提议、决议与通知都不留下**。
> 通知行从不被保密/解除保密更新，隐藏只发生在参与者的查询视图层，故解除保密后恢复的是**原已读状态**。

---

## 六、数据模型（SQLite）

> **跨版净变化对照不新增表、不做数据迁移**：净变化在查询时由 `versions.segments_json` 快照与
> `proposals` 中 `status='published'` 记录的发布坐标（`start_cp/end_cp/replacement/published_version_id`）
> 现场沿修订链重放计算；对照是只读操作，不写入也不改写任何既有记录。

- `versions`：不可变版本，`segments_json` 为该版全文快照，`decision_watermark` 界定该版可见的决议。
- `proposals`：修订提议；记录段号、码点范围、替换文字、依据、**基版 `base_version_id`**、
  基版原文摘录、状态机（pending → adopted/rejected/conflicted → published）与冲突原因。
  `conflict_kind` 区分冲突类别（`base_expired` 基版已过期 / `overlap` 范围交叠，旧库打开时自动补列并按原因文本回填）；
  `rebased_from_id` 记录续提来源——由哪个“基版已过期”冲突提议换算重提而来，双向可追溯；
  `restore_target_version_id` 记录**恢复提议**的目标历史版本（非空即为“把当前正文恢复到该版”
  所生成；恢复提议在确认事务内直接以 `adopted` 落库，旧库打开时自动补列）。
- `decisions`：决议审计流（adopt / reject / conflict / rebase / restore / publish），不可变追加。
  `restore` 决议记录每一条恢复提议的批次 id（同一次确认共享 `batchId`）、当前版本与目标版本、段与区间。
- `objections` + `objection_anchors`：异议主表（含永久原文快照）与逐版本锚点；
  发布时按修订映射，相交即置 `needs_relocation`。`objection_logs` 记录创建与重定位操作。
- `objection_responses`：**发布前异议回应**。回应保存非空说明、触及该异议的暂存提议 id 快照
  （`proposal_ids_json`）、回应时版本（`version_id`）、暂存区指纹（`stage_fingerprint`）与异议锚点快照；
  未发布草稿可被重新回应取代（`status='superseded'`，留痕保留），发布核对通过后写入
  `published_version_id` 随版只读归档。发布事务内重新核对绑定，任一缺失/失效即整体回滚。
- `segment_secrets`：**段级保密状态**。以段号为主键（存在行即保密），全局一份，不随版本复制；
  因发布只改段内正文、段号跨版本不变，故一条记录立即作用于当前及全部历史版本。
- `secret_logs`：**保密/解除保密留痕**。记录段号、动作（`classify`/`declassify`）、操作人、
  时间与前后状态（`previous_state`/`new_state`），不可变追加。保密不更新任何版本与业务记录表，
  对参与者的屏蔽只在视图层按 `segment_secrets` 过滤。
- `proposal_attachments`：**提议依据附件**。保存所属提议、**仅作展示的原始文件名**（`display_name`）、
  随机落盘相对名（`stored_name`，唯一，绝不使用客户端原名拼路径）、按内容嗅探的 `media_type`/`mime_type`、
  字节数、**预期摘要 `expected_sha256` 与实算摘要 `actual_sha256`**（两者相等才允许落库）、上传者与时间。
  附件冻结与否不额外建列——由所属 `proposals.status` 实时决定（仅 `pending` 可增删）；
  删除是硬删除（同时移除磁盘文件），保留的附件随提议与历史决议永久留存；续提只新建提议，不复制附件行。
- `segment_follows`：**段关注关系**。`(user_id, seg)` 主键，按用户隔离；关注只影响之后的成功发布，
  取消关注是行删除但**不级联删除**通知。
- `segment_notifications`：**段发布通知**。记录接收用户、段号、两端版本号
  （`from_version_id` 上一已发布版本 / `to_version_id` 本次新版本）与已读状态（`is_read`/`read_at`）。
  唯一索引 `UNIQUE(user_id, to_version_id, seg)` 保证**同版同段每人至多一条**；仅在发布事务内写入，
  发布失败随事务回滚，故失败发布不留通知。表行**从不因保密/解除保密或取消关注而更新/删除**：
  参与者当前保密段的通知只在查询视图层过滤隐藏、不计未读，解除保密后原样恢复（含原已读状态）。

---

## 七、目录结构

```
.
├── Dockerfile               # 多阶段构建（原生模块编译 + 精简运行镜像）
├── docker-compose.yml       # 一键启动，含数据卷与健康检查
├── .env.example             # 配置样例（端口、会话、种子账户）
├── package.json
├── sample-transcript.txt    # 示例逐字稿
├── src
│   ├── server.js            # Express 路由与错误出口（含附件原始字节上传/下载）
│   ├── auth.js              # Cookie 会话与角色鉴权
│   ├── db.js                # SQLite 连接、建表、种子账户
│   ├── store.js             # 业务核心：导入/提议/复核/发布/续提/异议/版本视图/正文来源/跨版净变化/恢复到历史版本/附件权限/段关注通知
│   ├── attachments.js       # 依据附件：内容类型嗅探、SHA-256、临时文件原子落盘
│   └── text.js              # 码点偏移、范围校验、合版、引用映射、续提换算、来源重放、跨版净变化（身份链对齐；恢复净变化同源）
├── public                   # 浏览器前端（原生 HTML/CSS/JS，无构建步骤）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test
    ├── unit.test.js         # 文本算子、解析与附件类型嗅探的单元测试
    ├── e2e.test.js          # 临时库 + 真实 HTTP 的端到端测试
    ├── attachments.test.js  # 附件：校验/权限/冻结/删除/续提不继承/并发/无孤儿
    ├── attachments-restart.test.js # 附件：同一数据目录重启后的持久化与权限回归
    ├── follow-notifications.test.js # 段关注/通知：净变化才通知、幂等已读、他人通知 403、保密隐藏与恢复、失败发布不留通知
    └── restore.test.js      # 恢复到历史版本：预览/确认拒绝场景、净变化逐段提议、重复文字不同文配对、未变化范围不触及异议、空暂存与整批回滚、经门槛发布不改写旧版、来源/通知回归
```
