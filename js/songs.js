/* ============================================================
 * songs.js —— K歌练习曲库
 *   只用「公有领域」旋律 + 自编练习曲，避免版权问题。
 *   格式：旋律写成字符串，每个记号是  音名[:拍数]
 *         C4 D4 E4:2 R:1     （R = 休止符，默认 1 拍）
 *   音名用 C D E F G A B + #/b + 八度，例：A2、F#4、Bb3
 * ============================================================ */
window.SONG_LIB = [
  {
    id: 'scale',
    title: '音阶上下行（热身）',
    tag: '练习',
    bpm: 90,
    tip: '每个音 1 拍，慢慢来。这条最能暴露"往上滑"的毛病。',
    melody: 'C4 D4 E4 F4 G4 A4 B4 C5 C5 B4 A4 G4 F4 E4 D4 C4'
  },
  {
    id: 'arp',
    title: '琶音跳进（do-mi-sol-do）',
    tag: '练习',
    bpm: 90,
    tip: '跳进比级进难。唱之前先在脑子里"预听"那个高音。',
    melody: 'C4 E4 G4 C5 G4 E4 C4 D4 F4 A4 D5 A4 F4 D4 C4 E4 G4 C5 G4 E4 C4'
  },
  {
    id: 'twinkle',
    title: '小星星 Twinkle Twinkle',
    tag: '儿歌·公有领域',
    bpm: 100,
    tip: '旋律简单但音程跳跃多（do→sol），很适合练准。',
    melody: 'C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2 G4 G4 F4 F4 E4 E4 D4:2 G4 G4 F4 F4 E4 E4 D4:2 C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2'
  },
  {
    id: 'frog',
    title: '两只老虎 Frère Jacques',
    tag: '民谣·公有领域',
    bpm: 110,
    tip: '有低音 sol3，注意别越唱越高。',
    melody: 'C4 D4 E4 C4 C4 D4 E4 C4 E4 F4 G4:2 E4 F4 G4:2 G4 A4 G4 F4 E4 C4 G4 A4 G4 F4 E4 C4 C4 G3 C4:2 C4 G3 C4:2'
  },
  {
    id: 'joy',
    title: '欢乐颂 Ode to Joy',
    tag: '古典·公有领域',
    bpm: 100,
    tip: '贝多芬第九。旋律以级进为主，是练稳定性的好材料。',
    melody: 'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4:1.5 D4:0.5 D4:2 E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4:1.5 C4:0.5 C4:2'
  },
  {
    id: 'jingle',
    title: 'Jingle Bells',
    tag: '儿歌·公有领域',
    bpm: 120,
    tip: '节奏偏快，先 0.6x 慢练。',
    melody: 'E4 E4 E4:2 E4 E4 E4:2 E4 G4 C4 D4 E4:4 F4 F4 F4 F4 F4 E4 E4 E4:0.5 E4:0.5 E4:1 D4 D4 E4 D4:2 G4:2'
  },
  {
    id: 'birthday',
    title: '生日快乐 Happy Birthday',
    tag: '民谣·公有领域',
    bpm: 100,
    tip: '原调最高到 sol5，男生一般要降一个八度唱 —— 点「自动适配我的音域」就行。',
    melody: 'G4:0.5 G4:0.5 A4 G4 C5 B4:2 G4:0.5 G4:0.5 A4 G4 D5 C5:2 G4:0.5 G4:0.5 G5 E5 C5 B4 A4 F5:0.5 F5:0.5 E5 C5 D5 C5:2'
  }
];