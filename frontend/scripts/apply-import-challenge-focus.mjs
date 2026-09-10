import fs from 'node:fs';

const file='src/pages/ProjectImport.tsx';
let text=fs.readFileSync(file,'utf8');

const stateNeedle='  const pumpCountdown=`${Math.floor(pumpSecondsLeft/60)}:${String(pumpSecondsLeft%60).padStart(2,"0")}`;\n\n  const securityRisks=';
const stateReplacement='  const pumpCountdown=`${Math.floor(pumpSecondsLeft/60)}:${String(pumpSecondsLeft%60).padStart(2,"0")}`;\n  const pumpChallengeActive=Boolean(reviewablePumpMismatch&&pumpChallenge?.status==="pending");\n\n  const securityRisks=';
if(!text.includes(stateNeedle)) throw new Error('challenge state marker not found');
text=text.replace(stateNeedle,stateReplacement);

const sectionStart='    <section className={embedded ? "space-y-5" : "mwz-hud-frame space-y-5 p-5"}>\n      <div><div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">1. Choose chain</div>';
const sectionStartReplacement='    {!pumpChallengeActive?<section className={embedded ? "space-y-5" : "mwz-hud-frame space-y-5 p-5"}>\n      <div><div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">1. Choose chain</div>';
if(!text.includes(sectionStart)) throw new Error('import form start marker not found');
text=text.replace(sectionStart,sectionStartReplacement);

const sectionEnd='      {canSelectImage?<div data-project-import-image-required="true"><label htmlFor="project-import-image" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">4. Project image</label><p className="mt-2 text-xs text-muted-foreground">{canRequestManual||manualReviewMine?"Add the image you want to use on MemeWarzone. If we need to review the token, it stays hidden until we approve it.":"Ownership and security checks passed. Add the project image to finish registration."} PNG, JPEG or WEBP.</p><div className="mt-3 flex items-center gap-3"><input id="project-import-image" disabled={working} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e)=>chooseImage(e.target.files?.[0]||null)}/><span className="text-xs text-muted-foreground">{imageFile?imageFile.name:item?.imageUrl?"Image already attached":"No image selected"}</span></div>{imagePreview?<img src={imagePreview} alt="Selected project" className="mt-3 h-16 w-16 rounded-md object-cover"/>:null}</div>:null}\n    </section>\n';
const sectionEndReplacement=sectionEnd.replace('    </section>\n','    </section>:null}\n');
if(!text.includes(sectionEnd)) throw new Error('import form end marker not found');
text=text.replace(sectionEnd,sectionEndReplacement);

fs.writeFileSync(file,text);
