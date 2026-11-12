# 第三方内容声明

`product-dev` 插件的自有内容（入口技能及其方法文档、插件清单、工程套件、产品设计技能组）以 MIT 许可发布，版权人与许可全文见 [LICENSE](LICENSE)。

插件还收录了下列第三方项目的内容。它们各自保留原许可，不受上面的 MIT 许可覆盖。第 1 到 3 项是原文：由仓库的 `tools/build-plugin.mjs` 从原版复制，除本文件写明的改动外不做修改，版本和内容哈希记录在 [BUILD.lock.json](BUILD.lock.json)。第 4、5 项是翻译和改写：入口技能的方法文档取用这两个项目的方法，译为中文并按本插件的流程调整，部分段落接近原文的直译，没有收录它们的原文件；每份改写文件的末尾注明了出处和改动。

## 1. impeccable

- 来源：<https://github.com/pbakaus/impeccable>
- 版本：4.8.2（`skill-v4.8.2` 之后的 main 提交 ec229b4；固定引擎 0.1.22）
- 原许可：Apache-2.0
- 版权声明：Copyright 2025 Paul Bakaus
- 收录位置与取自：
  - [skills/impeccable/](skills/impeccable/SKILL.md)：取自上游已构建的 `plugin/skills/impeccable/`
  - [skills/impeccable/LICENSE](skills/impeccable/LICENSE)、[skills/impeccable/NOTICE.md](skills/impeccable/NOTICE.md)：取自上游仓库根目录，原样保留
  - `agents/impeccable-asset-producer.md`、`agents/impeccable-documenter.md`、`agents/impeccable-finish-reviewer.md`、`agents/impeccable-manual-edit-applier.md`：取自上游 `plugin/agents/`
- 我们的改动：`skills/impeccable/SKILL.md` 文件头的 `user-invocable` 由 `true` 改为 `false`（不出现在命令菜单，由入口技能加载），并加了一行说明改动的注释。`skills/impeccable/reference/audit.md` 和 `audit.native.md` 去掉了末尾的“Save the Report”一节，原位置留一行说明改动的注释：该节调用的 `audit-storage` 命令在上游 main 已加入，但收录时固定的引擎 0.1.22 还没有，照原文执行会报 `Unknown command`；上游发布带该命令的引擎、我们升级固定版本后恢复原文。其余文件与上游检出的内容相同（文本文件用 LF；`scripts/impeccable.cmd` 按上游的规定用 CRLF）。上游插件的会话钩子（`plugin/hooks/`）没有收录。
- 运行时的联网行为（上游原有，我们没有改）：启动脚本 `skills/impeccable/scripts/impeccable`（Windows 上是 `impeccable.cmd`）在本机找不到引擎程序时，会从 <https://github.com/pbakaus/impeccable/releases> 下载对应版本的可执行文件到用户目录的 `.impeccable/`，按 `scripts/engine-checksums.txt` 校验后运行。安装插件本身不会触发下载。
- impeccable 自己引用的第三方内容（摘自它的 `NOTICE.md`，该文件里的 `skill/reference/` 对应本插件的 `skills/impeccable/reference/`）：
  - `reference/ios.md` 和 `reference/android.md` 提炼自 ehmo 的 platform-design-skills（Apple Human Interface Guidelines 与 Material Design 3 的规则），由 impeccable 改写
  - 原作品：<https://github.com/ehmo/platform-design-skills>；原许可：MIT；作者：ehmo。该仓库 LICENSE 的版权行是 `Copyright (c) 2026`，没有写名字（2026-11-10 查阅）
- impeccable 技能目录里还带有一个上游 `NOTICE.md` 没有列出的第三方库：`skills/impeccable/scripts/modern-screenshot.umd.js`，是 [modern-screenshot](https://github.com/qq15725/modern-screenshot) 的打包文件（文件内没有标版本和许可头）。该项目的许可是 MIT，版权行是 `Copyright (c) 2021-present wxm`（2026-11-10 查阅其仓库 LICENSE）

## 2. archify

- 来源：<https://github.com/tt-a1i/archify>
- 版本：3.2.0（提交 7e45f36）
- 原许可：Apache-2.0（文件、包清单或第三方声明另有说明的除外，见它的 NOTICE）
- 版权声明：Copyright (c) 2026 tt-a1i (Archify)；Copyright (c) 2025 Cocoon AI
- 收录位置与取自：[skills/archify/](skills/archify/SKILL.md)，取自上游的技能包目录 `archify/`
- 原样保留的许可与声明文件：
  - [skills/archify/LICENSE](skills/archify/LICENSE)（Apache-2.0）
  - [skills/archify/LICENSE-MIT](skills/archify/LICENSE-MIT)（转为 Apache-2.0 之前的历史 MIT 授权）
  - [skills/archify/NOTICE](skills/archify/NOTICE)
  - [skills/archify/THIRD_PARTY_NOTICES.md](skills/archify/THIRD_PARTY_NOTICES.md)：archify 自己收录的第三方内容，包括 Simple Icons 等品牌标识的矢量数据（各标识有各自的许可与商标条款）、JetBrains Mono 字体（SIL OFL 1.1，全文在 [skills/archify/assets/JetBrainsMono-OFL.txt](skills/archify/assets/JetBrainsMono-OFL.txt)）、Pele 1.3.0（MIT，许可在 [skills/archify/explainer/vendor/pele/LICENSE](skills/archify/explainer/vendor/pele/LICENSE)）
- 我们的改动：
  - `skills/archify/SKILL.md` 文件头加了 `user-invocable: false`（不出现在命令菜单，由入口技能加载）和一行说明改动的注释
  - 没有收录 `examples/` 下 15 个 `.html` 示例成品页（约 12.8MB）；它们是示例输入渲染后的结果，只被上游重新生成示例的脚本 `scripts/render-examples.mjs` 引用。示例输入（`examples/*.json`）照常收录
  - 其余文件原样
- 运行时的联网行为（上游原有，我们没有改）：`scripts/check-update.mjs` 会按 `skill-release.json` 里的地址查询 archify 有没有新版本，说明见 `skills/archify/references/update-awareness.md`

## 3. feature-dev

- 来源：<https://github.com/anthropics/claude-plugins-official>（`plugins/feature-dev`）
- 版本：1.0.1（本机存档取自 Claude Code 的插件缓存，不是 git 检出；安装记录里对应的市场仓库提交是 f8c5e7a）
- 原许可：Apache-2.0
- 版权声明：上游的 LICENSE 文件没有填写版权人；插件清单的作者署名是 Anthropic
- 收录位置与取自：`agents/code-explorer.md`、`agents/code-architect.md`、`agents/code-reviewer.md`，取自上游 `agents/`
- 我们的改动：无，三个文件原样

## 4. ponytail

- 来源：<https://github.com/DietrichGebert/ponytail>
- 版本：5.3.3（提交 96608e0）
- 原许可：MIT
- 版权声明：Copyright (c) 2026 DietrichGebert
- 参考的原文件：`skills/ponytail/SKILL.md`（最小改动规则）、`skills/ponytail-review/SKILL.md`（评审检查项）
- 本插件里的改写文件：
  - [skills/product-dev/references/build.md](skills/product-dev/references/build.md)：第 1、2、6 节
  - [skills/product-dev/references/self-review.md](skills/product-dev/references/self-review.md)
- 我们的改动：译为中文。`build.md` 第 1、2、6 节和 `self-review.md` 第 1 到 3 节接近原文的逐句翻译，只做了少量调整；其余部分按本插件的流程重写。去掉了常驻模式、级别切换、回复结尾格式和评审报告格式；原文“只注释为什么”“琐碎改动不必写测试”两条改为以项目闸门为准；评审清单从“应要求出报告”改为“作者推送前自查”，并加了本项目特有的检查项。没有收录 ponytail 的钩子、命令和其余技能。

## 5. agent-skills

- 来源：<https://github.com/addyosmani/agent-skills>
- 版本：0.6.15（提交 301b02b）
- 原许可：MIT
- 版权声明：Copyright (c) 2025 Addy Osmani
- 参考的原文件：`skills/planning-and-task-breakdown/SKILL.md`、`skills/incremental-implementation/SKILL.md`、`skills/debugging-and-error-recovery/SKILL.md`、`skills/code-review-and-quality/SKILL.md`、`skills/security-and-hardening/SKILL.md`、`references/security-checklist.md`
- 本插件里的改写文件：
  - [skills/product-dev/references/planning.md](skills/product-dev/references/planning.md)
  - [skills/product-dev/references/build.md](skills/product-dev/references/build.md)：第 5 节
  - [skills/product-dev/references/debugging.md](skills/product-dev/references/debugging.md)
  - [skills/product-dev/references/review.md](skills/product-dev/references/review.md)：第 3、4、6 节和首轮任务书里的评审步骤
- 我们的改动：译为中文。各文件的结构、表格和步骤贴近原文（依赖图、任务大小表、调试六步、五个评审维度等），措辞是翻译加改写；文件位置、任务字段、严重级别、报告格式和登记要求按本插件的工程套件重写；逐片循环从“先实现再测试”改为“先写测试再实现”；没有采用原文的输出路径（`tasks/`）、git 流程、示例代码和评审时限；修 bug 时失败测试排在修复之前；复审者只读，变异实验提前到首次候选、由作者做。没有收录 agent-skills 的其余技能、命令、钩子和子代理。

## 许可全文

### Apache License 2.0

适用于上面第 1、2、3 项。

```text

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
```

### MIT License

适用于：ponytail（版权行见上文第 4 项）、agent-skills（版权行见上文第 5 项）、platform-design-skills（版权行见上文第 1 项）、modern-screenshot（版权行见上文第 1 项）、archify 的历史 MIT 授权（版权人见 `skills/archify/LICENSE-MIT`）、Pele（版权人见 `skills/archify/explainer/vendor/pele/LICENSE`）。

```text
MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
