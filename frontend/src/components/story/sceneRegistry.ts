import { BattleScene } from "./scenes/BattleScene";
import { CallScene } from "./scenes/CallScene";
import { ChartScene } from "./scenes/ChartScene";
import { ClanScene } from "./scenes/ClanScene";
import { CoverScene } from "./scenes/CoverScene";
import { CountsScene } from "./scenes/CountsScene";
import { MomentScene } from "./scenes/MomentScene";
import { ProgressScene } from "./scenes/ProgressScene";
import { StandingScene } from "./scenes/StandingScene";
import { TextScene } from "./scenes/TextScene";
import { TradesScene } from "./scenes/TradesScene";
import { WarcryScene } from "./scenes/WarcryScene";

export const sceneRegistry = {
  cover: CoverScene,
  text: TextScene,
  warcry: WarcryScene,
  moment: MomentScene,
  counts: CountsScene,
  trades: TradesScene,
  clan: ClanScene,
  progress: ProgressScene,
  chart: ChartScene,
  battle: BattleScene,
  standing: StandingScene,
  call: CallScene,
};
