// multiplayer-style: [multiplayer] 分组样式在 ASS 导出中的解析；依赖由 editor-utils.js 注入。
// 每个分组导出一行独立 Style（MP01…MP12）。第 1 阶段只替换外观：
// 字体、字号、颜色、描边、阴影等取分组样式，位置（对齐与边距）仍沿用原角色样式，
// 槽位排版在第 3 阶段由 multiplayer-layout 接管。
export function createUtilsModule(dependencies) {
  'use strict';
  const { ASS_REFERENCE_PLAY_RES_Y, assStyleLine, normalizeAssFontSize, normalizeAssStyle } = dependencies;

  const MULTIPLAYER_POSITION_FIELDS = Object.freeze(['alignment', 'marginL', 'marginR', 'marginV']);

  function multiplayerStyleName(index) {
    return `MP${String(index + 1).padStart(2, '0')}`;
  }

  function withRolePosition(groupStyle, roleStyle) {
    const style = { ...groupStyle };
    if (roleStyle) MULTIPLAYER_POSITION_FIELDS.forEach((field) => {
      if (roleStyle[field] !== undefined) style[field] = roleStyle[field];
    });
    return style;
  }

  // 多人模式关闭、数据缺失或不在 ASS 方案模式时返回 null，导出走上游原路径。
  function createMultiplayerAssContext(data, { resolutionHeight = ASS_REFERENCE_PLAY_RES_Y } = {}) {
    if (!data || data.enabled !== true || !Array.isArray(data.groups) || !data.groups.length) return null;
    const height = Number(resolutionHeight) > 0 ? Number(resolutionHeight) : ASS_REFERENCE_PLAY_RES_Y;
    const groups = data.groups.map((group, index) => {
      const style = normalizeAssStyle(group?.style, undefined, `mp-g${String(index + 1).padStart(2, '0')}`);
      return {
        index,
        id: group?.id,
        speaker: typeof group?.speaker === 'string' ? group.speaker : '',
        style,
        styleName: multiplayerStyleName(index),
        // 样式库字号按 1080p 参考存储，导出按 PlayResY 换算（与主样式规则一致）。
        fontSize: normalizeAssFontSize(style.fontSize * height / ASS_REFERENCE_PLAY_RES_Y),
      };
    });
    const resolve = dependencies.resolveMultiplayerGroupIndex;
    return Object.freeze({
      groups,
      cueStyle(track, segment, trackSegments, roleStyle) {
        const group = groups[resolve(data, track, segment, trackSegments)] || groups[0];
        return {
          group,
          style: withRolePosition(group.style, roleStyle),
          styleName: group.styleName,
          fontSize: group.fontSize,
          speaker: group.speaker,
        };
      },
      styleLines(baseStyle) {
        return groups.map((group) => assStyleLine(withRolePosition(group.style, baseStyle), group.styleName, group.fontSize));
      },
    });
  }

  return Object.freeze({ createMultiplayerAssContext, multiplayerStyleName });
}
