// Acrobat JavaScript 控制台脚本：列出 3D 注释中每个网格的名称、面数和包围盒。
// 说明：Acrobat 的 3D JavaScript API 不提供顶点或三角形数据的读取接口（Mesh 对象只有
// computeBoundingBox、faceCount、transform、material 等成员），因此本脚本无法导出几何体，
// 只能导出每个结构的元数据，用于日后核对配准结果。未在 Acrobat 中实际运行验证。
// 用法：在 Acrobat Pro 中打开 wu2015_corr_pone.0140736.s004.pdf，单击 3D 模型使其激活，
// 按 Cmd+J 打开 JavaScript 控制台，粘贴全部内容，选中后按 Cmd+Enter 执行，再把控制台输出
// 复制保存为 data/raw/female/pelvic_floor/wu2015_acrobat_meshes.tsv。
//
// Acrobat JavaScript console script: list name, face count and bounding box of every mesh in
// the 3D annotation.
// Note: Acrobat's 3D JavaScript API exposes no vertex or triangle data (a Mesh object only has
// computeBoundingBox, faceCount, transform, material and similar members), so this cannot export
// geometry. It dumps per-structure metadata only, for checking a later registration. It has not
// been run in Acrobat.
// Usage: open wu2015_corr_pone.0140736.s004.pdf in Acrobat Pro, click the 3D model to activate
// it, press Cmd+J for the JavaScript console, paste everything, select it and press Cmd+Enter,
// then save the console output as data/raw/female/pelvic_floor/wu2015_acrobat_meshes.tsv.

(function () {
  var annot = this.getAnnots3D(0)[0]; // 第 1 页上唯一的 3D 注释 / the only 3D annotation, on page 1
  annot.activated = true;
  var c3d = annot.context3D; // 3D 脚本引擎的全局对象 / global object of the 3D script engine
  if (!c3d) {
    console.println("3D annotation is not active yet: click the model, then run again");
    return;
  }
  var scene = c3d.scene;
  var rows = ["name\tfaceCount\tminX\tminY\tminZ\tmaxX\tmaxY\tmaxZ"];
  for (var i = 0; i < scene.meshes.count; i++) {
    var m = scene.meshes.getByIndex(i);
    var b = m.computeBoundingBox(); // 包围盒所在坐标系未经核实 / coordinate space of the box not verified
    rows.push([m.name, m.faceCount, b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].join("\t"));
  }
  console.println(rows.join("\n"));
}).call(this);
