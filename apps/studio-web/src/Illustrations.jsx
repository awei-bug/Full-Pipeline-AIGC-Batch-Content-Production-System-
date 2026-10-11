/**
 * 极简线性插画。统一用 currentColor 描边，颜色由外部 class 控制，
 * 深浅色主题下自动适配。全部为内联 SVG，不依赖任何图片资源。
 */

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

/** 叙事弧与角色节点：用于数字 IP 工作台的 hero */
export function StoryArc({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 220 140" role="img" aria-label="叙事弧线与角色节点示意图" {...base}>
      <path d="M14 120h192" opacity="0.26" />
      <path d="M14 116 60 78 106 92 152 44 206 30" opacity="0.8" />
      <circle cx="60" cy="78" r="5" />
      <circle cx="106" cy="92" r="5" />
      <circle cx="152" cy="44" r="5" />
      <circle cx="206" cy="30" r="5" />
      <path d="M38 120v-7M86 120v-7M134 120v-7M182 120v-7" opacity="0.32" />
    </svg>
  );
}

/** 图片帧与视频帧：用于内容工作流的 hero */
export function FlowNodes({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 220 140" role="img" aria-label="图片帧与视频帧示意图" {...base}>
      <rect x="16" y="26" width="76" height="60" rx="9" opacity="0.8" />
      <circle cx="42" cy="48" r="6" opacity="0.55" />
      <path d="M22 78l20-19 16 15 14-11 14 15" opacity="0.45" />
      <rect x="118" y="34" width="86" height="52" rx="11" opacity="0.8" />
      <path d="M152 47l20 13-20 13z" opacity="0.55" />
      <path d="M16 104h188" opacity="0.26" />
      <path d="M98 62h14" opacity="0.45" />
    </svg>
  );
}

/** 空画布：用于结果区的空状态 */
export function EmptyCanvas({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 120 120" role="img" aria-label="暂无内容" {...base}>
      <rect x="16" y="24" width="88" height="66" rx="10" opacity="0.7" />
      <circle cx="42" cy="44" r="7" opacity="0.5" />
      <path d="M18 74l22-19 18 15 16-12 30 22" opacity="0.45" />
      <path d="M40 104h40" opacity="0.3" />
    </svg>
  );
}

/** 等待轨道：用于生成中的等待态，外圈虚线缓慢旋转 */
export function WaitingOrbit({ className = "" }) {
  return (
    <svg className={className} viewBox="0 0 120 120" role="img" aria-label="等待生成" {...base}>
      <g className="illus-ring">
        <circle cx="60" cy="60" r="30" opacity="0.4" strokeDasharray="4 7" />
      </g>
      <circle cx="60" cy="60" r="17" opacity="0.6" />
      <circle cx="60" cy="30" r="5" />
      <path d="M60 60l15-15" opacity="0.5" />
    </svg>
  );
}
