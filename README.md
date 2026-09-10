# 上传文件目录格式示例

## 旧版地图数据包解包结构 对应 isLinear == false

```
.
├── resource_manifest.json
├── resource/
│   └── primefonts/
│       └── fbUsv8C5eI.ttf
└── convert/
    ├── packages/
    │   ├── worldmaplist.json
    │   └── worlds/
    │       ├── egypt/
    │       │   └── worldmap.json
    │       ├── future/
    │       │   └── worldmap.json
    │       └── ...
    └── images/
        ├── {resolution1}/
        │   ├── initial/
        │   │   ├── worldmap/
        │   │   │   ├── common/
        │   │   │   │   ├── misssingartpiece.png
        │   │   │   │   ├── star.png
        │   │   │   │   ├── star_empty.png
        │   │   │   │   └── upgrade_%s.png
        │   │   │   ├── keygate_flag.png
        │   │   │   ├── info_icon.png
        │   │   │   ├── level_node/
        │   │   │   ├── stargate/
        │   │   │   ├── giftbox_world_map/
        │   │   │   ├── sprout/
        │   │   │   ├── danger_node_egypt/
        │   │   │   ├── danger_level_egypt.png
        │   │   │   ├── gate_egypt/
        │   │   │   └── path_egypt/
        │   │   ├── UI/
        │   │   │   ├── packets/
        │   │   │   │   ├── ready.png
        │   │   │   │   ├── dots_left.png
        │   │   │   │   ├── dots_bottom.png
        │   │   │   │   ├── dots_right.png
        │   │   │   │   ├── bonkchoy.png
        │   │   │   │   └── ...
        │   │   │   └── hud_worldmap/
        │   │   │       ├── icon_key_future.png
        │   │   │       └── ...
        │   │   ├── plant/
        │   │   │   ├── bonkchoy/
        │   │   │   └── ...
        │   │   └── effects/
        │   │       ├── collected_upgrade_effect/
        │   │       └── ...
        │   └── full/
        │       └── worldmap/
        │           ├── cowboy/
        │           │   ├── island1.png
        │           │   ├── island2.png
        │           │   └── ...
        │           ├── pirate/
        │           │   ├── island1.png
        │           │   └── ...
        │           ├── danger_node_cowboy/
        │           ├── gate_future/
        │           ├── ...
        │           ├── path_future/
        │           ├── ...
        │           ├── anim_future1/
        │           ├── anim_future2/
        │           ├── ...
        │           ├── anim_pirate1/
        │           ├── anim_pirate2/
        │           └── ...
        └── ...
```

## 新版地图数据包解包结构 对应 isLinear == true

```
.
├── resource_manifest.json
├── resource/
│   └── primefonts/
│       └── fbUsv8C5eI.ttf
└── convert/
    ├── packages/
    │   ├── worldmaplist.json
    │   └── worlds/
    │       ├── egypt/
    │       │   └── worldmap.json
    │       ├── future/
    │       │   └── worldmap.json
    │       ├── iceage/
    │       │   └── worldmap.json
    │       ├── rift1/
    │       │   └── worldmap.json
    │       ├── rift2/
    │       │   └── worldmap.json
    │       └── ...
    └── images/
        ├── {resolution}
        │   ├── initial/
        │   │   ├── worldmap/
        │   │   │   ├── common/
        │   │   │   │   ├── misssingartpiece.png
        │   │   │   │   ├── upgrade_%s.png
        │   │   │   │   └── ...
        │   │   │   ├── level_node/
        │   │   │   ├── level_node_minigame/
        │   │   │   ├── level_node_gargantuar/
        │   │   │   ├── giftbox_world_map/
        │   │   │   ├── sprout/
        │   │   │   ├── danger_node_egypt/
        │   │   │   ├── danger_level_egypt.png
        │   │   │   ├── zomboss_node_egypt/
        │   │   ├── UI/
        │   │   │   └── packets/
        │   │   │       ├── ready.png
        │   │   │       ├── dots_left.png
        │   │   │       ├── dots_bottom.png
        │   │   │       ├── dots_right.png
        │   │   │       ├── bonkchoy.png
        │   │   │       └── ...
        │   │   ├── plant/
        │   │   │   ├── bonkchoy/
        │   │   │   └── ...
        │   │   └── effects/
        │   │       └── collected_upgrade_effect/
        │   └── full/
        │       └── worldmap/
        │           ├── future/
        │           │   ├── island0.png
        │           │   ├── island1.png
        │           │   ├── island2.png
        │           │   ├── ...
        │           │   ├── anim1/
        │           │   ├── anim2/
        │           │   └── ...
        │           ├── pirate/
        │           │   ├── island0.png
        │           │   ├── ...
        │           │   ├── anim1/
        │           │   ├── anim2/
        │           │   └── ...
        │           ├── ...
        │           ├── twister/
        │           │   └── ...
        │           ├── zomboss_node_future/
        │           ├── ...
        │           └── danger_node_future/
        │           ├── ...
        │           ├── danger_level_future.png
        │           ├── ...
```
- 以上结构只是标准格式，动画的`json`统一只放在`768`下的动画目录内，中文版需要用脚本转换为以上格式，
- 考虑到`resource_manifest.json`中复杂的路径，中文版`plantPacket`仍然保留在`1536`或`768`下的`UIActive`或`UICommon`下的`UI/packets/`，除此之外的地图资源全部按照国际版格式
- 对于国际版线性地图的早期版本的混杂情况需要用脚本来处理：
  - 早期的线性地图版本的世界岛屿动画仍然存放在旧版目录
  - `worldmap.json`的part1/part2版本分开保存
  - 部分版本`darkage`世界图像和动画的文件名、目录带有`part2`后缀
  - 前4个世界在线性地图早期阶段仍然使用旧的动画id保存方式
  - 部分版本`darkage`世界专属植物动画存放在`initial`目录
  - 部分版本worldmap数据中的的plant仍使用动画名作为而非逻辑名

