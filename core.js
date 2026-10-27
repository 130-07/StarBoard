(function (root) {
  'use strict';
  const tasks = [
    ['Close major DV',4],['Close weekly sterile documentation',7],['Trend report',5],
    ['Re-validation',8],['Initial validation',10],['Monitoring',3],['APS',5],
    ['FMECA',10],['ECC',2],['CA',4],['Cycle development',8],['Close minor DV',1]
  ];
  const events = [
    {id:'escape',title:'The Great Escape',type:'Escape room',icon:'🔐',color:'#735393',description:'Share clues, crack puzzles and solve a mystery together.',provider:'Escape Copenhagen',url:'https://escape-cph.dk/en/team-building-for-companies/'},
    {id:'shuffle',title:'Shuffle & Social',type:'Shuffleboard',icon:'🥌',color:'#34776c',description:'Friendly rivalry, plenty of cheering and time to catch up.',provider:'Petanque & Shuffleboard Bar',url:'https://petanquebar.dk/'},
    {id:'cook',title:'Aprons On, Team!',type:'Cooking class',icon:'🍳',color:'#9b6046',description:'Cook together, share some kitchen laughs and enjoy your meal.',provider:'CPH Cooking Class',url:'https://www.copenhagencookingclass.com/company-events/'},
    {id:'pottery',title:'Paint, Chat & Create',type:'Pottery painting',icon:'🎨',color:'#a96c91',description:'Pick a ceramic piece, add some colour and enjoy a relaxed creative catch-up.',provider:'Creative Space',url:'https://creative-space.dk/pages/virksomheder'}
  ];
  const blank = () => ({round:1,carry:0,entries:[],events:0,poll:{votes:[],closed:false,winner:null},revision:0});
  const normalize = name => name.trim().replace(/\s+/g,' ').toLowerCase();
  const total = state => state.carry + state.entries.filter(e=>e.round===state.round).reduce((n,e)=>n+e.points,0);
  const leader = state => {
    if(state.poll.closed) return events.find(e=>e.id===state.poll.winner)||null;
    const tally=events.map(e=>({...e,count:state.poll.votes.filter(v=>v.event===e.id).length}));
    const max=Math.max(...tally.map(e=>e.count)),top=tally.filter(e=>e.count===max);
    return max>0&&top.length===1?top[0]:null;
  };
  function text(value,label,max) {
    if(typeof value!=='string'||!value.trim()||value.trim().length>max) throw new Error(label+' is required (maximum '+max+' characters).');
    return value.trim();
  }
  function registration(data) {
    let taskLabel,points;
    if(data.task==='custom') {
      taskLabel=text(data.title,'Task description',160);points=Number(data.points);
      if(!Number.isInteger(points)||points<1||points>100) throw new Error('Choose a whole number of points from 1 to 100.');
    } else {
      if(!/^(?:[0-9]|1[01])$/.test(String(data.task)))throw new Error('Choose a valid task.');
      const i=Number(data.task);
      if(!Number.isInteger(i)||!tasks[i]) throw new Error('Choose a valid task.');
      [taskLabel,points]=tasks[i];
    }
    return {taskLabel,points,name:text(data.name,'Performed by',100),reference:text(data.reference,'Reference',2000)};
  }
  function apply(state,action,data,id) {
    const s=structuredClone(state);
    if(action==='register') {
      if(s.entries.some(e=>e.id===id))return s;
      if(total(s)>=100) throw new Error('This round is complete. Start the next round first.');
      s.entries.push({...registration(data),id,time:new Date().toISOString(),round:s.round});
      if(total(s)>=100)s.events++;
    } else if(action==='undo') {
      const e=s.entries.at(-1);
      if(!e||e.round!==s.round||e.id!==data.id)throw new Error('The log changed. Please select Undo again.');
      const before=total(s);s.entries.pop();if(before>=100&&total(s)<100)s.events--;
    } else if(action==='next') {
      const n=total(s);if(n<100)throw new Error('Reach 100 points before starting a new round.');
      s.carry=n-100;s.round++;
    } else if(action==='vote') {
      if(s.poll.closed)throw new Error('Voting is closed.');
      const name=text(data.name,'Your name',100);
      if(!events.some(e=>e.id===data.event))throw new Error('Choose a valid event.');
      const vote=s.poll.votes.find(v=>normalize(v.name)===normalize(name));
      if(vote){vote.event=data.event;vote.name=name}else s.poll.votes.push({name,event:data.event});
    } else if(action==='finalize') {
      const winner=leader(s);if(!winner)throw new Error('A clear winner is needed to finalize voting.');
      s.poll.closed=true;s.poll.winner=winner.id;
    } else if(action==='reopen') {s.poll.closed=false;s.poll.winner=null}
    else throw new Error('Unknown action.');
    s.revision++;return s;
  }
  root.StarCore={tasks,events,blank,normalize,total,leader,registration,apply};
  if(typeof module!=='undefined')module.exports=root.StarCore;
})(typeof window!=='undefined'?window:globalThis);
