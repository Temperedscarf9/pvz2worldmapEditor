import { parseAnimation, transformToMatrix, multiplyMatrix, parseSpriteFrameLabels } from './model';
import {
  buildAllTimelines,
  computeAnimationBounds,
  getChildSpriteInfo,
  getTimelineSnapshot,
} from './timeline';
import type { Animation, TimelinesMap, Matrix6, Color } from './types';

// 缓存已经做过 RGB 乘法的 Canvas（不包含 alpha 累积）
const tintCache = new Map<string, HTMLCanvasElement>();

function getCacheKey(
    img: HTMLImageElement,
    sourceRect: [number, number, number, number] | null,
    rgb: { r: number; g: number; b: number }
): string {
  const srcPart = sourceRect ? `${sourceRect[0]}_${sourceRect[1]}_${sourceRect[2]}_${sourceRect[3]}` : 'full';
  const r = (rgb.r * 255) | 0;
  const g = (rgb.g * 255) | 0;
  const b = (rgb.b * 255) | 0;
  // 使用 img.src 作为唯一标识（不同图像可能同名但不同源）
  return `${img.src}_${srcPart}_${r}_${g}_${b}`;
}

/**
 * 对图像应用 RGB 乘法（不改变 alpha）
 * 使用 GPU 加速的 Canvas 合成混合进行高速染色，避免 getImageData 引发的 CPU-GPU 管线同步阻塞
 */
function createTintedImage(
    img: HTMLImageElement,
    sourceRect: [number, number, number, number] | null,
    rgb: { r: number; g: number; b: number }
): HTMLCanvasElement {
  // 确定源区域
  let srcX = 0, srcY = 0, srcW = img.width, srcH = img.height;
  if (sourceRect) {
    srcX = Math.max(0, sourceRect[0]);
    srcY = Math.max(0, sourceRect[1]);
    srcW = Math.min(sourceRect[2], img.width - srcX);
    srcH = Math.min(sourceRect[3], img.height - srcY);
    if (srcW <= 0 || srcH <= 0) {
      srcX = srcY = 0;
      srcW = img.width;
      srcH = img.height;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = srcW;
  canvas.height = srcH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // 1. 绘制原始图像（仅源区域）
  ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

  // 2. 如果 RGB 系数不是全 1，则使用高效的 Canvas globalCompositeOperation 合成
  if (rgb.r !== 1 || rgb.g !== 1 || rgb.b !== 1) {
    const r = (rgb.r * 255) | 0;
    const g = (rgb.g * 255) | 0;
    const b = (rgb.b * 255) | 0;

    try {
      // 2.1 创建离屏 canvas
      const offscreen = document.createElement('canvas');
      offscreen.width = srcW;
      offscreen.height = srcH;
      const oCtx = offscreen.getContext('2d');
      if (oCtx) {
        // 2.2 填充目标 RGB 颜色
        oCtx.fillStyle = `rgb(${r},${g},${b})`;
        oCtx.fillRect(0, 0, srcW, srcH);

        // 2.3 使用 destination-in 保持与原图一致的 Alpha 遮罩
        oCtx.globalCompositeOperation = 'destination-in';
        oCtx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

        // 2.4 在主 canvas 上，通过 multiply 混合模式与原图进行 RGB 分量相乘
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.drawImage(offscreen, 0, 0);
        ctx.restore();
      }
    } catch (e) {
      console.warn('Tinting failed due to image security constraints', e);
    }
  }

  return canvas;
}

function renderSpriteTree2D(
    ctx: CanvasRenderingContext2D,
    animation: Animation,
    textures: Map<string, HTMLImageElement>,
    timelines: TimelinesMap,
    spriteIndex: number,
    frameIndex: number,
    parentMatrix: Matrix6,
    parentColor: Color,          // 累积的 RGBA 颜色（父级所有颜色的乘积）
    spriteVisible: boolean[],
): void {
  const snapshotContext = getTimelineSnapshot(animation, timelines, spriteIndex, frameIndex);
  if (!snapshotContext) return;

  const { actualFrame, snapshot } = snapshotContext;

  for (const layer of snapshot) {
    const layerMatrix = multiplyMatrix(parentMatrix, layer.transform);
    // 累积颜色 = 父颜色 * 当前图层颜色
    const accumulatedColor = {
      r: parentColor.r * layer.color.r,
      g: parentColor.g * layer.color.g,
      b: parentColor.b * layer.color.b,
      a: parentColor.a * layer.color.a,
    };

    if (layer.isSprite) {
      if (layer.resource < spriteVisible.length && !spriteVisible[layer.resource]) {
        continue;
      }
      const childInfo = getChildSpriteInfo(animation, layer, actualFrame);
      if (!childInfo) continue;
      const { childSpriteIndex, adjustedFrame } = childInfo;

      ctx.save();
      if (layer.additive) {
        ctx.globalCompositeOperation = 'lighter';
      }
      // 递归绘制子精灵，传递累积颜色
      renderSpriteTree2D(
          ctx,
          animation,
          textures,
          timelines,
          childSpriteIndex,
          adjustedFrame,
          layerMatrix,
          accumulatedColor,
          spriteVisible   // 向下传递
      );
      ctx.restore();
      continue;
    }

    // 图像图层
    const imageDef = animation.image[layer.resource];
    if (!imageDef) continue;

    const img = textures.get(imageDef.name);
    if (!img) continue;

    // 图像自身变换矩阵
    const imgMatrix = imageDef._cachedMatrix || transformToMatrix(imageDef.transform);
    const finalMatrix = multiplyMatrix(layerMatrix, imgMatrix);

    // 绘制尺寸
    const drawW = imageDef.size?.width ?? img.width;
    const drawH = imageDef.size?.height ?? img.height;
    if (drawW <= 0 || drawH <= 0) continue;

    const baseW = img.width;
    const baseH = img.height;
    if (baseW <= 0 || baseH <= 0) continue;

    const scaleX = drawW / baseW;
    const scaleY = drawH / baseH;

    // 缩放后的变换矩阵
    const scaledMatrix: Matrix6 = [
      finalMatrix[0] * scaleX, finalMatrix[1] * scaleX,
      finalMatrix[2] * scaleY, finalMatrix[3] * scaleY,
      finalMatrix[4], finalMatrix[5]
    ];

    ctx.save();

    // 混合模式
    if (layer.additive) {
      ctx.globalCompositeOperation = 'lighter';
    }

    // 应用变换
    ctx.setTransform(
        scaledMatrix[0], scaledMatrix[1],
        scaledMatrix[2], scaledMatrix[3],
        scaledMatrix[4], scaledMatrix[5]
    );

    // 最终透明度 = 累积颜色的 alpha
    ctx.globalAlpha = accumulatedColor.a;

    // 判断是否需要 RGB tint
    const needRgbTint = (accumulatedColor.r < 0.99 || accumulatedColor.g < 0.99 || accumulatedColor.b < 0.99);

    if (needRgbTint) {
      // 使用缓存的 RGB‑tinted 图像（已经完成了 RGB 乘法，alpha 保持原图不变）
      const rgb = { r: accumulatedColor.r, g: accumulatedColor.g, b: accumulatedColor.b };
      const key = getCacheKey(img, layer.sourceRect, rgb);
      let tintedCanvas = tintCache.get(key);
      if (!tintedCanvas) {
        if (tintCache.size > 2000) {
          tintCache.clear();
        }
        tintedCanvas = createTintedImage(img, layer.sourceRect, rgb);
        tintCache.set(key, tintedCanvas);
      }
      // tintedCanvas 的 alpha 是原始图像 of alpha，因此只需要通过 globalAlpha 乘上累积透明度
      if (layer.sourceRect) {
        // 修正纹理裁剪时的偏移 bug：绘制在 sourceRect 指定的目标 (sx, sy) 偏移坐标上
        ctx.drawImage(tintedCanvas, layer.sourceRect[0], layer.sourceRect[1]);
      } else {
        ctx.drawImage(tintedCanvas, 0, 0);
      }
    } else {
      // 无需 RGB 变换，直接绘制原图
      if (layer.sourceRect) {
        const [sx, sy, sw, sh] = layer.sourceRect;
        const clippedW = Math.min(sw, baseW - sx);
        const clippedH = Math.min(sh, baseH - sy);
        if (clippedW > 0 && clippedH > 0) {
          ctx.drawImage(
              img,
              sx, sy, clippedW, clippedH,
              sx, sy, clippedW, clippedH
          );
        }
      } else {
        ctx.drawImage(img, 0, 0);
      }
    }

    ctx.restore();
  }
}

export function clearTintCache(): void {
  tintCache.clear();
}

export class PamCanvasPlayer {
  private canvas: HTMLCanvasElement;
  private anim: Animation;
  private textures: Map<string, HTMLImageElement>;
  private timelines: TimelinesMap;
  private bounds: { x: number; y: number; width: number; height: number };
  private currentFrame = 0;
  private targetFps = 30;
  private lastTime = 0;
  private playing = true;
  private currentLabel: string | null = null;
  private labelRange: { begin: number; end: number } | null = null;
  private loop = true;
  private destroyed = false;
  private spriteVisible: boolean[] = [];
  private animKey: string = '';

  private isVisible = true;
  private lastRenderedFrame = -1;

  private static observer: IntersectionObserver | null = null;

  private static getObserver(): IntersectionObserver | null {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      return null;
    }
    if (!PamCanvasPlayer.observer) {
      PamCanvasPlayer.observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const canvas = entry.target as HTMLCanvasElement;
              const player = (canvas as any).__player;
              if (player) {
                player.isVisible = entry.isIntersecting;
                if (player.isVisible && player.playing) {
                  player.lastRenderedFrame = -1;
                  player.lastTime = performance.now();
                }
              }
            }
          },
          {
            rootMargin: '120px',
            threshold: 0,
          }
      );
    }
    return PamCanvasPlayer.observer;
  }

  private delayMin = 0;
  private delayMax = 0;
  private currentDelayRemaining = 0;
  private hasDelayDetails = false;

  public setDelayDetails(min: number, max: number): void {
    this.delayMin = min;
    this.delayMax = max;
    this.hasDelayDetails = true;
    const delay = this.delayMin + Math.random() * (this.delayMax - this.delayMin);
    this.currentDelayRemaining = delay;

    const activeSprite = this.anim.mainSprite || this.anim.sprite[0];
    if (activeSprite) {
      const begin = this.labelRange ? this.labelRange.begin : 0;
      const end = this.labelRange ? this.labelRange.end : activeSprite.frame.length - 1;
      const isStopFrame = activeSprite.frame[end]?.stop === true;
      const loopEnd = (this.labelRange && isStopFrame && end > begin) ? (end - 1) : end;

      this.currentFrame = loopEnd;
      this.lastRenderedFrame = -1;
      this.draw();
    }
  }

  private labelProbabilityBucket: Record<string, number> | null = null;
  private probabilitySide: string | null = null;
  private excludedThreshold: number = -1;

  public setLabelProbabilityBucket(bucket: Record<string, number> | null, side?: string | null): void {
    this.labelProbabilityBucket = bucket;
    this.probabilitySide = side || null;
    this.excludedThreshold = -1;
    if (bucket) {
      this.selectAndPlayBucketLabel();
    }
  }

  private selectAndPlayBucketLabel(startFrameOffset = 0): void {
    if (!this.labelProbabilityBucket) return;
    const selectedKey = this.chooseLabelFromBucket();
    if (!selectedKey) return;

    let finalLabel = selectedKey;
    if (this.probabilitySide) {
      if (selectedKey.includes('%s')) {
        finalLabel = selectedKey.replace('%s', this.probabilitySide);
      } else if (selectedKey.startsWith('_')) {
        finalLabel = 'locked_' + this.probabilitySide + selectedKey;
      }
    }

    this.playLabel(finalLabel, true, startFrameOffset);
  }

  private chooseLabelFromBucket(): string | null {
    if (!this.labelProbabilityBucket) return null;
    const keys = Object.keys(this.labelProbabilityBucket);
    if (keys.length === 0) return null;

    const totalOriginalWeight = keys.reduce((sum, k) => sum + (this.labelProbabilityBucket![k] || 0), 0);
    if (totalOriginalWeight <= 0) {
      return keys[Math.floor(Math.random() * keys.length)];
    }

    // Compute original probability for each key (ratio of its weight to total original weight)
    const originalProbabilities = new Map<string, number>();
    for (const key of keys) {
      const weight = this.labelProbabilityBucket[key] || 0;
      originalProbabilities.set(key, weight / totalOriginalWeight);
    }

    // Filter keys by checking if original probability is greater than the excludedThreshold
    let filteredKeys = keys.filter(key => {
      const originalP = originalProbabilities.get(key) || 0;
      return originalP > this.excludedThreshold;
    });

    // Fallback if all keys are excluded
    if (filteredKeys.length === 0) {
      this.excludedThreshold = -1;
      filteredKeys = keys;
    }

    const filteredTotalWeight = filteredKeys.reduce((sum, k) => sum + (this.labelProbabilityBucket![k] || 0), 0);
    let selectedKey: string;
    if (filteredTotalWeight <= 0) {
      selectedKey = filteredKeys[Math.floor(Math.random() * filteredKeys.length)];
    } else {
      let rand = Math.random() * filteredTotalWeight;
      let found = false;
      for (const key of filteredKeys) {
        const weight = this.labelProbabilityBucket[key] || 0;
        if (rand < weight) {
          selectedKey = key;
          found = true;
          break;
        }
        rand -= weight;
      }
      if (!found) {
        selectedKey = filteredKeys[filteredKeys.length - 1];
      }
    }

    // Update threshold based on the original probability of the selected event
    const chosenOriginalProb = originalProbabilities.get(selectedKey) || 0;
    if (chosenOriginalProb <= 0.15) {
      // Low probability event (<= 15%): exclude events with original probability <= chosenOriginalProb
      this.excludedThreshold = chosenOriginalProb;
    } else {
      // High probability event (> 15%): reset threshold, selecting normally next time
      this.excludedThreshold = -1;
    }

    return selectedKey;
  }

  constructor(
      canvas: HTMLCanvasElement,
      animation: Animation,
      textures: Map<string, HTMLImageElement>,
      animKey?: string
  ) {
    this.canvas = canvas;
    this.anim = animation;
    this.textures = textures;
    this.animKey = animKey || '';

    // 缓存生成的 timeline 避免多个 CanvasPlayer 实例重复生成
    const animAny = animation as any;
    if (!animAny._timelines) {
      animAny._timelines = buildAllTimelines(animation);
    }
    this.timelines = animAny._timelines;

    this.targetFps = animation.frameRate || 30;
    this.initSpriteVisibility();

    // 缓存生成的边界（按纹理缓存，因为不同分辨率的纹理尺寸不同）
    if (!animAny._bounds) {
      animAny._bounds = new Map<any, { x: number; y: number; width: number; height: number }>();
    }
    let bounds = animAny._bounds.get(textures);
    if (!bounds) {
      bounds = computeAnimationBounds(animation, textures, this.timelines);
      if (bounds.width <= 0 || bounds.height <= 0 || !isFinite(bounds.x)) {
        bounds = {
          x: 0,
          y: 0,
          width: animation.size[0] || 400,
          height: animation.size[1] || 400,
        };
      }
      animAny._bounds.set(textures, bounds);
    }
    this.bounds = bounds;

    const width = Math.ceil(this.bounds.width);
    const height = Math.ceil(this.bounds.height);
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.position = 'absolute';
    this.canvas.style.left = `${this.bounds.x}px`;
    this.canvas.style.top = `${this.bounds.y}px`;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.lastTime = performance.now();

    const obs = PamCanvasPlayer.getObserver();
    if (obs) {
      (this.canvas as any).__player = this;
      this.isVisible = false;
      obs.observe(this.canvas);
    } else {
      this.isVisible = true;
    }

    this.draw();
  }

  private initSpriteVisibility(): void {
    const spriteCount = this.anim.sprite.length;
    this.spriteVisible = new Array(spriteCount).fill(true);

    const key = (this.animKey || '').toLowerCase();
    const isPlant = key.includes('plant');

    const shadowPowerStems = [
      'dragonbabybruit',
      'dragonbruit',
      'dusklobber',
      'gloomvine',
      'grimrose',
      'guardshroom',
      'moonflower',
      'murkadamia',
      'nightshade',
      'noctarine',
      'powervine',
      'shadowpea',
      'shadowshroom',
    ];

    const isShadowPower = shadowPowerStems.some(stem => key.includes(stem));
    const isNightshade = key.includes('nightshade');
    const isMagnetshroom = key.includes('magnetshroom');
    const isWallnut = key.includes('wallnut') && !key.includes('tallnut');
    const isTallnut = key.includes('tallnut');
    const isEndurian = key.includes('endurian');

    for (let i = 0; i < spriteCount; i++) {
      const sp = this.anim.sprite[i];
      if (!sp.name) continue;
      const name = sp.name;

      let shouldHide = false;

      // 1. All plant animations: startsWith('custom_')
      if (isPlant && name.startsWith('custom_')) {
        shouldHide = true;
      }

      // 2. Nightshade: endsWith('_pf')
      if (isNightshade && name.endsWith('_pf')) {
        shouldHide = true;
      }

      // 3. Shadow power stems: includes('dark')
      if (isShadowPower && name.includes('dark')) {
        shouldHide = true;
      }

      // 4. Magnetshroom: includes('Magnet_Item')
      if (isMagnetshroom && name.includes('Magnet_Item')) {
        shouldHide = true;
      }

      // 5. Wallnut: includes('_wallnut_armor_states')
      if (isWallnut && name.includes('_wallnut_armor_states')) {
        shouldHide = true;
      }

      // 6. Tallnut: includes('_tallnut_plantfood_armor')
      if (isTallnut && name.includes('_tallnut_plantfood_armor')) {
        shouldHide = true;
      }

      // 7. Endurian: includes('endurian_plantfood_armor')
      if (isEndurian && name.includes('endurian_plantfood_armor')) {
        shouldHide = true;
      }

      // 8. Global overlay filters if needed
      if (name === 'ink' || name === 'butter' || name === 'ground_swatch' || name === 'ground_swatch_plane') {
        shouldHide = true;
      }

      if (shouldHide) {
        this.spriteVisible[i] = false;
      }
    }
  }

  public setPlayState(playing: boolean): void {
    this.playing = playing;
  }

  public getCurrentLabel(): string | null {
    return this.currentLabel;
  }

  public playLabel(label: string, loop = true, startFrameOffset = 0): void {
    this.currentLabel = label;
    this.loop = loop;
    this.lastRenderedFrame = -1;

    const activeSprite = this.anim.mainSprite || this.anim.sprite[0];
    if (!activeSprite) return;

    let begin = 0;
    let end = activeSprite.frame.length - 1;

    const labels = parseSpriteFrameLabels(activeSprite);
    const matched = labels.find(l => l.name === label);
    if (matched) {
      this.labelRange = { begin: matched.begin, end: matched.end };
      begin = matched.begin;
      end = matched.end;
    } else {
      const idx = activeSprite.frame.findIndex(f => f.label === label);
      if (idx !== -1) {
        this.labelRange = { begin: idx, end: activeSprite.frame.length - 1 };
        begin = idx;
        end = activeSprite.frame.length - 1;
      } else {
        this.labelRange = null;
        begin = 0;
        end = activeSprite.frame.length - 1;
      }
    }

    const isStopFrame = activeSprite.frame[end]?.stop === true;
    const loopEnd = (this.labelRange && isStopFrame && end > begin) ? (end - 1) : end;
    const frameCount = loopEnd - begin + 1;

    const matchedOffset = frameCount > 0 ? (startFrameOffset % frameCount) : 0;
    this.currentFrame = begin + matchedOffset;

    this.lastTime = performance.now();
    this.draw();
  }

  public setFrame(frameNum: number): void {
    const activeSprite = this.anim.mainSprite || this.anim.sprite[0];
    if (!activeSprite) return;
    this.currentFrame = Math.max(0, Math.min(frameNum, activeSprite.frame.length - 1));
    this.lastRenderedFrame = -1;
    this.draw();
  }

  public tick(now: number): void {
    if (this.destroyed) return;

    if (!this.playing) {
      this.lastTime = now;
      return;
    }

    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    if (dt > 0.1) dt = 0.1;

    if (this.currentDelayRemaining > 0) {
      this.currentDelayRemaining -= dt;
      if (this.currentDelayRemaining <= 0) {
        this.currentDelayRemaining = 0;
        const activeSprite = this.anim.mainSprite || this.anim.sprite[0];
        if (activeSprite) {
          this.currentFrame = this.labelRange ? this.labelRange.begin : 0;
        }
      }
      if (this.isVisible) {
        this.draw();
      }
      return;
    }

    const activeSprite = this.anim.mainSprite || this.anim.sprite[0];
    if (!activeSprite || activeSprite.frame.length === 0) return;

    const maxFrame = activeSprite.frame.length;
    const begin = this.labelRange ? this.labelRange.begin : 0;
    const end = this.labelRange ? this.labelRange.end : maxFrame - 1;

    const isStopFrame = activeSprite.frame[end]?.stop === true;
    const loopEnd = (this.labelRange && isStopFrame && end > begin) ? (end - 1) : end;
    const frameCount = loopEnd - begin + 1;

    this.currentFrame += dt * this.targetFps;

    if (this.currentFrame >= loopEnd + 1) {
      if (this.loop) {
        if (this.labelProbabilityBucket) {
          this.selectAndPlayBucketLabel();
        } else if (this.hasDelayDetails) {
          this.currentFrame = loopEnd;
          const delay = this.delayMin + Math.random() * (this.delayMax - this.delayMin);
          this.currentDelayRemaining = delay;
          if (this.currentDelayRemaining > 0) {
            if (this.isVisible) {
              this.draw();
            }
            return;
          } else {
            this.currentFrame = begin;
          }
        } else {
          this.currentFrame = begin + ((this.currentFrame - begin) % frameCount);
        }
      } else {
        this.currentFrame = loopEnd;
        this.playing = false;
      }
    }

    if (this.isVisible) {
      this.draw();
    }
  }

  private draw() {
    if (this.destroyed) return;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const width = Math.ceil(this.bounds.width);
    const height = Math.ceil(this.bounds.height);

    const activeSpriteIndex = this.anim.mainSprite ? -1 : 0;
    const activeSprite = this.anim.mainSprite || this.anim.sprite[0];
    if (!activeSprite || activeSprite.frame.length === 0) return;

    const begin = this.labelRange ? this.labelRange.begin : 0;
    const end = this.labelRange ? this.labelRange.end : activeSprite.frame.length - 1;

    const isStopFrame = activeSprite.frame[end]?.stop === true;
    const loopEnd = (this.labelRange && isStopFrame && end > begin) ? (end - 1) : end;

    let frameToRender = Math.floor(this.currentFrame);
    if (frameToRender > loopEnd) frameToRender = loopEnd;
    if (frameToRender < begin) frameToRender = begin;

    if (frameToRender === this.lastRenderedFrame) return;
    this.lastRenderedFrame = frameToRender;

    ctx.clearRect(0, 0, width, height);

    // 基础变换：将动画内容平移到画布左上角（边界对齐）
    const baseMatrix: Matrix6 = [1, 0, 0, 1, -this.bounds.x, -this.bounds.y];
    const whiteColor: Color = { r: 1, g: 1, b: 1, a: 1 };

    renderSpriteTree2D(
        ctx,
        this.anim,
        this.textures,
        this.timelines,
        activeSpriteIndex,
        frameToRender,
        baseMatrix,
        whiteColor,
        this.spriteVisible,
    );
  }

  public destroy(): void {
    this.destroyed = true;
    const obs = PamCanvasPlayer.getObserver();
    if (obs) {
      obs.unobserve(this.canvas);
      (this.canvas as any).__player = null;
    }
  }
}
