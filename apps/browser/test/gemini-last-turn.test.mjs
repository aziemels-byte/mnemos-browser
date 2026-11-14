import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {modelAnswerExtractionScript} from '../src/model-answer-capture.mjs';
import {pollResponse} from '../src/answer-polling.mjs';
import {councilPrompt} from '../src/council-conversation.mjs';

const seed='Iepazīstamies un noskaidrojam, kā vislabāk sadarboties.';
const answers=[
  {model:'ChatGPT',status:'CAPTURED',answer:'Piekrītu Gemini un Perplexity: domstarpības jāatrisina ar pārbaudāmiem pierādījumiem. Mans jautājums nākamajam dalībniekam: kā izveidot kopīgu atmiņas un lēmumu sistēmu, kas atzīmē novecojušu lēmumu?'},
  {model:'Perplexity',status:'CAPTURED',answer:'Es piedāvātu vienkāršu principu: katram lēmumam jābūt atjaunināmam. Ja parādās jauns tests vai pierādījums, iepriekšējā lēmuma statuss jāmaina. Mans jautājums: kāds ir mazākais iespējamais lēmuma ieraksts, ko MNEMOS varētu saglabāt?'}
];
const prompt=councilPrompt({seed,turns:answers,model:'Gemini'});
const answer='Pilnībā piekrītu gan ChatGPT domai par dinamisko lomu maiņu, gan Perplexity piedāvātajam ciklam, kurā katrs lēmums ir dzīvs un atjaunināmā stāvoklī. Atbildot uz Perplexity jautājumu, mazākais iespējamais lēmuma ieraksts sastāvētu no četriem obligātiem laukiem: paša lēmuma, galvenā pieņēmuma, atcelšanas nosacījuma un statusa ar laika zīmogu. Bez skaidri definēta atcelšanas kritērija ir grūti pamanīt, ka jauns fakts ir sagrāvis veco loģiku. Šāds formāts ļautu MNEMOS funkcionēt kā pārskatāmai versiju kontroles sistēmai. Mans jautājums nākamajam dalībniekam: kā noteikt, kad mūsu kritiskā pārbaude kļūst par lieku bremzi lietotājam?';
function read(body, buttons=[]){
  return vm.runInNewContext(modelAnswerExtractionScript('Gemini',{prompt}),{
    document:{
      title:'Gemini conversation',body:{innerText:body},
      querySelectorAll:selector=>selector==='button,[role="button"]'?buttons:[]
    }
  });
}
function fixture({latestPrompt=true,reflow=true,latestAnswer=answer}={}){
 const user=reflow?prompt.replaceAll('\n\n','\n\n\n\n'):prompt;
 return 'Gemini\nAuto\nConversation with Gemini\n'+
   'You said Earlier unrelated greeting\n\nOld question\nGemini said\nOld completed response.\n'+
   (latestPrompt?'You said MNEMOS Browser · GPT/Gemini/Perplexity īsta iepazīšanās saruna.\n\n'+user:'')+
   '\n\nGemini said\n\n'+latestAnswer;
}
test('sixth Gemini response is extracted from the CURRENT reflowed council prompt, not an older reply',async()=>{
 const result=read(fixture());
 assert.equal(result.kind,'GEMINI_STABLE_TURN_TEXT_CANDIDATE');
 assert.equal(result.promptFound,true);
 assert.equal(result.assistantAfterPrompt,true);
 assert.equal(result.answer,answer);
 const got=await pollResponse({sample:async()=>result,assistantOnly:true,stableReads:2,
   intervalMs:0,maxAttempts:3,wait:async()=>{}});
 assert.equal(got.state,'CANDIDATE_CAPTURED');
 assert.equal(got.attempts,2);
});
test('Gemini extractor fails closed on missing exact prompt, incomplete reply, or ongoing generation',()=>{
 for(const text of [fixture({latestPrompt:false}),
   fixture({latestAnswer:'Still generating with no ending punctuation'}),
   fixture().replace('Tu esi Gemini. Atbildi latviski','Tu esi Cits. Atbildi latviski')]){
   const result=read(text);
   assert.notEqual(result.kind,'GEMINI_STABLE_TURN_TEXT_CANDIDATE');
   assert.equal(result.answer,'');
 }
 const busy=read(fixture(),[{getAttribute:()=>'Stop response',innerText:''}]);
 assert.equal(busy.busy,true);
 assert.notEqual(busy.kind,'GEMINI_STABLE_TURN_TEXT_CANDIDATE');
});
