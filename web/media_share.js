/* Media-only sharing. Work and memory are bounded to the current batch. */
(() => {
  'use strict';
  const words = {
    en:['Share media','Preparing media…','Batch {n} of {total}','Choose an app to share your media.','Next batch','Share again','Done','Cancel','Could not prepare the selected media. No files were skipped. Try again or select fewer files.','No media to share.','File sharing is unavailable in this browser.','Large selections are shared in batches of up to 100 files. The receiving app may have a smaller limit.','Files {from}–{to} of {total}','Sharing cancelled'],
    hi:['मीडिया साझा करें','मीडिया तैयार हो रहा है…','बैच {n} / {total}','मीडिया साझा करने के लिए कोई ऐप चुनें।','अगला बैच','फिर साझा करें','हो गया','रद्द करें','चुना गया मीडिया तैयार नहीं हुआ। कोई फ़ाइल छोड़ी नहीं गई। फिर कोशिश करें या कम फ़ाइलें चुनें।','साझा करने के लिए मीडिया नहीं है।','इस ब्राउज़र में फ़ाइल साझा करना उपलब्ध नहीं है।','बड़े चयन अधिकतम 100 फ़ाइलों के बैच में साझा होते हैं। प्राप्तकर्ता ऐप की सीमा कम हो सकती है।','फ़ाइलें {from}–{to} / {total}','साझा करना रद्द हुआ'],
    bn:['মিডিয়া শেয়ার করুন','মিডিয়া প্রস্তুত হচ্ছে…','ব্যাচ {n} / {total}','মিডিয়া শেয়ার করার জন্য একটি অ্যাপ বেছে নিন।','পরের ব্যাচ','আবার শেয়ার করুন','সম্পন্ন','বাতিল','নির্বাচিত মিডিয়া প্রস্তুত করা যায়নি। কোনো ফাইল বাদ যায়নি। আবার চেষ্টা করুন বা কম ফাইল বাছুন।','শেয়ার করার মিডিয়া নেই।','এই ব্রাউজারে ফাইল শেয়ার করা যায় না।','বড় নির্বাচন সর্বোচ্চ 100টি ফাইলের ব্যাচে শেয়ার হয়। গ্রহণকারী অ্যাপের সীমা কম হতে পারে।','ফাইল {from}–{to} / {total}','শেয়ার বাতিল হয়েছে'],
    te:['మీడియాను షేర్ చేయండి','మీడియా సిద్ధమవుతోంది…','బ్యాచ్ {n} / {total}','మీడియాను షేర్ చేయడానికి ఒక యాప్‌ను ఎంచుకోండి.','తదుపరి బ్యాచ్','మళ్లీ షేర్ చేయండి','పూర్తయింది','రద్దు','ఎంచుకున్న మీడియా సిద్ధం కాలేదు. ఏ ఫైల్‌నూ వదిలేయలేదు. మళ్లీ ప్రయత్నించండి లేదా తక్కువ ఫైళ్లు ఎంచుకోండి.','షేర్ చేయడానికి మీడియా లేదు.','ఈ బ్రౌజర్‌లో ఫైల్ షేరింగ్ అందుబాటులో లేదు.','పెద్ద ఎంపికలు గరిష్ఠంగా 100 ఫైళ్ల బ్యాచ్‌లలో షేర్ అవుతాయి. స్వీకరించే యాప్ పరిమితి తక్కువగా ఉండవచ్చు.','ఫైళ్లు {from}–{to} / {total}','షేరింగ్ రద్దయింది'],
    ta:['ஊடகத்தைப் பகிரவும்','ஊடகம் தயாராகிறது…','தொகுதி {n} / {total}','ஊடகத்தைப் பகிர ஓர் செயலியைத் தேர்ந்தெடுக்கவும்.','அடுத்த தொகுதி','மீண்டும் பகிரவும்','முடிந்தது','ரத்து','தேர்ந்தெடுத்த ஊடகத்தைத் தயாரிக்க முடியவில்லை. எந்தக் கோப்பும் விடப்படவில்லை. மீண்டும் முயலவும் அல்லது குறைவான கோப்புகளைத் தேர்ந்தெடுக்கவும்.','பகிர ஊடகம் இல்லை.','இந்த உலாவியில் கோப்புகளைப் பகிர முடியாது.','பெரிய தேர்வுகள் அதிகபட்சம் 100 கோப்புகள் கொண்ட தொகுதிகளாகப் பகிரப்படும். பெறும் செயலியின் வரம்பு குறைவாக இருக்கலாம்.','கோப்புகள் {from}–{to} / {total}','பகிர்வு ரத்தானது'],
    mr:['मीडिया शेअर करा','मीडिया तयार होत आहे…','बॅच {n} / {total}','मीडिया शेअर करण्यासाठी अॅप निवडा.','पुढील बॅच','पुन्हा शेअर करा','झाले','रद्द करा','निवडलेला मीडिया तयार करता आला नाही. कोणतीही फाइल वगळलेली नाही. पुन्हा प्रयत्न करा किंवा कमी फाइल निवडा.','शेअर करण्यासाठी मीडिया नाही.','या ब्राउझरमध्ये फाइल शेअर करणे उपलब्ध नाही.','मोठ्या निवडी जास्तीत जास्त 100 फाइलच्या बॅचमध्ये शेअर होतात. स्वीकारणाऱ्या ॲपची मर्यादा कमी असू शकते.','फाइल {from}–{to} / {total}','शेअर करणे रद्द झाले'],
    gu:['મીડિયા શેર કરો','મીડિયા તૈયાર થઈ રહ્યું છે…','બેચ {n} / {total}','મીડિયા શેર કરવા માટે કોઈ ઍપ પસંદ કરો.','આગલી બેચ','ફરી શેર કરો','પૂર્ણ','રદ કરો','પસંદ કરેલું મીડિયા તૈયાર થઈ શક્યું નથી. કોઈ ફાઇલ છોડી નથી. ફરી પ્રયાસ કરો અથવા ઓછી ફાઇલો પસંદ કરો.','શેર કરવા મીડિયા નથી.','આ બ્રાઉઝરમાં ફાઇલ શેર કરવાનું ઉપલબ્ધ નથી.','મોટી પસંદગીઓ વધુમાં વધુ 100 ફાઇલની બેચમાં શેર થાય છે. મેળવનાર ઍપની મર્યાદા ઓછી હોઈ શકે છે.','ફાઇલો {from}–{to} / {total}','શેર કરવાનું રદ થયું'],
    kn:['ಮಾಧ್ಯಮ ಹಂಚಿಕೊಳ್ಳಿ','ಮಾಧ್ಯಮ ಸಿದ್ಧವಾಗುತ್ತಿದೆ…','ಬ್ಯಾಚ್ {n} / {total}','ಮಾಧ್ಯಮ ಹಂಚಿಕೊಳ್ಳಲು ಒಂದು ಆ್ಯಪ್ ಆಯ್ಕೆಮಾಡಿ.','ಮುಂದಿನ ಬ್ಯಾಚ್','ಮತ್ತೆ ಹಂಚಿಕೊಳ್ಳಿ','ಮುಗಿದಿದೆ','ರದ್ದುಮಾಡಿ','ಆಯ್ಕೆಮಾಡಿದ ಮಾಧ್ಯಮ ಸಿದ್ಧಪಡಿಸಲಾಗಲಿಲ್ಲ. ಯಾವುದೇ ಫೈಲ್ ಬಿಟ್ಟಿಲ್ಲ. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ ಅಥವಾ ಕಡಿಮೆ ಫೈಲ್ ಆಯ್ಕೆಮಾಡಿ.','ಹಂಚಿಕೊಳ್ಳಲು ಮಾಧ್ಯಮ ಇಲ್ಲ.','ಈ ಬ್ರೌಸರ್‌ನಲ್ಲಿ ಫೈಲ್ ಹಂಚಿಕೆ ಲಭ್ಯವಿಲ್ಲ.','ದೊಡ್ಡ ಆಯ್ಕೆಗಳನ್ನು ಗರಿಷ್ಠ 100 ಫೈಲ್‌ಗಳ ಬ್ಯಾಚ್‌ಗಳಲ್ಲಿ ಹಂಚಿಕೊಳ್ಳಲಾಗುತ್ತದೆ. ಸ್ವೀಕರಿಸುವ ಆ್ಯಪ್ ಮಿತಿ ಕಡಿಮೆಯಾಗಿರಬಹುದು.','ಫೈಲ್‌ಗಳು {from}–{to} / {total}','ಹಂಚಿಕೆ ರದ್ದಾಗಿದೆ'],
    ml:['മീഡിയ പങ്കിടുക','മീഡിയ തയ്യാറാക്കുന്നു…','ബാച്ച് {n} / {total}','മീഡിയ പങ്കിടാൻ ഒരു ആപ്പ് തിരഞ്ഞെടുക്കുക.','അടുത്ത ബാച്ച്','വീണ്ടും പങ്കിടുക','പൂർത്തിയായി','റദ്ദാക്കുക','തിരഞ്ഞെടുത്ത മീഡിയ തയ്യാറാക്കാനായില്ല. ഒരു ഫയലും ഒഴിവാക്കിയിട്ടില്ല. വീണ്ടും ശ്രമിക്കുക അല്ലെങ്കിൽ കുറച്ച് ഫയലുകൾ തിരഞ്ഞെടുക്കുക.','പങ്കിടാൻ മീഡിയ ഇല്ല.','ഈ ബ്രൗസറിൽ ഫയൽ പങ്കിടൽ ലഭ്യമല്ല.','വലിയ തിരഞ്ഞെടുപ്പുകൾ പരമാവധി 100 ഫയലുള്ള ബാച്ചുകളായി പങ്കിടും. സ്വീകരിക്കുന്ന ആപ്പിന്റെ പരിധി കുറവായിരിക്കാം.','ഫയലുകൾ {from}–{to} / {total}','പങ്കിടൽ റദ്ദാക്കി'],
    pa:['ਮੀਡੀਆ ਸਾਂਝਾ ਕਰੋ','ਮੀਡੀਆ ਤਿਆਰ ਹੋ ਰਿਹਾ ਹੈ…','ਬੈਚ {n} / {total}','ਮੀਡੀਆ ਸਾਂਝਾ ਕਰਨ ਲਈ ਇੱਕ ਐਪ ਚੁਣੋ।','ਅਗਲਾ ਬੈਚ','ਮੁੜ ਸਾਂਝਾ ਕਰੋ','ਹੋ ਗਿਆ','ਰੱਦ ਕਰੋ','ਚੁਣਿਆ ਮੀਡੀਆ ਤਿਆਰ ਨਹੀਂ ਹੋਇਆ। ਕੋਈ ਫਾਈਲ ਛੱਡੀ ਨਹੀਂ ਗਈ। ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ ਜਾਂ ਘੱਟ ਫਾਈਲਾਂ ਚੁਣੋ।','ਸਾਂਝਾ ਕਰਨ ਲਈ ਮੀਡੀਆ ਨਹੀਂ ਹੈ।','ਇਸ ਬ੍ਰਾਊਜ਼ਰ ਵਿੱਚ ਫਾਈਲ ਸਾਂਝੀ ਕਰਨਾ ਉਪਲਬਧ ਨਹੀਂ ਹੈ।','ਵੱਡੀਆਂ ਚੋਣਾਂ ਵੱਧ ਤੋਂ ਵੱਧ 100 ਫਾਈਲਾਂ ਦੇ ਬੈਚ ਵਿੱਚ ਸਾਂਝੀਆਂ ਹੁੰਦੀਆਂ ਹਨ। ਪ੍ਰਾਪਤ ਕਰਨ ਵਾਲੀ ਐਪ ਦੀ ਸੀਮਾ ਘੱਟ ਹੋ ਸਕਦੀ ਹੈ।','ਫਾਈਲਾਂ {from}–{to} / {total}','ਸਾਂਝਾ ਕਰਨਾ ਰੱਦ ਹੋਇਆ']
  };
  const types = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',heic:'image/heic',heif:'image/heif',avif:'image/avif',svg:'image/svg+xml',tif:'image/tiff',tiff:'image/tiff',mp4:'video/mp4',m4v:'video/mp4',mov:'video/quicktime',webm:'video/webm',mkv:'video/x-matroska',avi:'video/x-msvideo',wmv:'video/x-ms-wmv',flv:'video/x-flv',ts:'video/mp2t','3gp':'video/3gpp',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',aac:'audio/aac',ogg:'audio/ogg',opus:'audio/opus',flac:'audio/flac',wma:'audio/x-ms-wma',mid:'audio/midi',midi:'audio/midi'};
  const pause = () => new Promise(r=>setTimeout(r,0));
  const panelWords={
    en:['Expand sharing','Minimize sharing','Move sharing panel','Processing video…','Ready to share','Open share sheet','{percent}% prepared','Needs attention','Preparing in the background. You can keep using PicShelf.','Try again','Share sheet opened'],
    hi:['शेयर पैनल खोलें','शेयर पैनल छोटा करें','शेयर पैनल खिसकाएँ','वीडियो तैयार हो रहा है…','साझा करने के लिए तैयार','शेयर स्क्रीन खोलें','{percent}% तैयार','ध्यान दें','पृष्ठभूमि में तैयारी जारी है। आप PicShelf का उपयोग करते रह सकते हैं।','फिर कोशिश करें','शेयर स्क्रीन खुल गई'],
    bn:['শেয়ার প্যানেল খুলুন','শেয়ার প্যানেল ছোট করুন','শেয়ার প্যানেল সরান','ভিডিও প্রস্তুত হচ্ছে…','শেয়ার করার জন্য প্রস্তুত','শেয়ার স্ক্রিন খুলুন','{percent}% প্রস্তুত','মনোযোগ প্রয়োজন','পটভূমিতে প্রস্তুতি চলছে। আপনি PicShelf ব্যবহার করতে পারেন।','আবার চেষ্টা করুন','শেয়ার স্ক্রিন খুলেছে'],
    te:['షేర్ ప్యానెల్ విస్తరించండి','షేర్ ప్యానెల్ చిన్నది చేయండి','షేర్ ప్యానెల్ జరపండి','వీడియో సిద్ధమవుతోంది…','షేర్ చేయడానికి సిద్ధం','షేర్ తెర తెరవండి','{percent}% సిద్ధమైంది','శ్రద్ధ అవసరం','నేపథ్యంలో సిద్ధమవుతోంది. మీరు PicShelf ఉపయోగించడం కొనసాగించవచ్చు.','మళ్లీ ప్రయత్నించండి','షేర్ తెర తెరుచుకుంది'],
    ta:['பகிர்வுப் பலகையை விரிக்கவும்','பகிர்வுப் பலகையைச் சுருக்கவும்','பகிர்வுப் பலகையை நகர்த்தவும்','வீடியோ தயாராகிறது…','பகிரத் தயார்','பகிர்வுத் திரையைத் திறக்கவும்','{percent}% தயார்','கவனம் தேவை','பின்னணியில் தயாராகிறது. நீங்கள் PicShelf-ஐத் தொடர்ந்து பயன்படுத்தலாம்.','மீண்டும் முயலவும்','பகிர்வுத் திரை திறந்தது'],
    mr:['शेअर पॅनेल उघडा','शेअर पॅनेल लहान करा','शेअर पॅनेल हलवा','व्हिडिओ तयार होत आहे…','शेअर करण्यासाठी तयार','शेअर स्क्रीन उघडा','{percent}% तयार','लक्ष द्या','पार्श्वभूमीत तयारी सुरू आहे. तुम्ही PicShelf वापरत राहू शकता.','पुन्हा प्रयत्न करा','शेअर स्क्रीन उघडली'],
    gu:['શેર પેનલ ખોલો','શેર પેનલ નાની કરો','શેર પેનલ ખસેડો','વિડિયો તૈયાર થઈ રહ્યો છે…','શેર કરવા માટે તૈયાર','શેર સ્ક્રીન ખોલો','{percent}% તૈયાર','ધ્યાન આપો','પૃષ્ઠભૂમિમાં તૈયારી ચાલુ છે. તમે PicShelf વાપરતા રહી શકો છો.','ફરી પ્રયાસ કરો','શેર સ્ક્રીન ખુલી'],
    kn:['ಹಂಚಿಕೆ ಫಲಕ ವಿಸ್ತರಿಸಿ','ಹಂಚಿಕೆ ಫಲಕ ಚಿಕ್ಕದಾಗಿಸಿ','ಹಂಚಿಕೆ ಫಲಕ ಸರಿಸಿ','ವೀಡಿಯೊ ಸಿದ್ಧವಾಗುತ್ತಿದೆ…','ಹಂಚಿಕೊಳ್ಳಲು ಸಿದ್ಧ','ಹಂಚಿಕೆ ಪರದೆ ತೆರೆಯಿರಿ','{percent}% ಸಿದ್ಧ','ಗಮನ ಅಗತ್ಯ','ಹಿನ್ನೆಲೆಯಲ್ಲಿ ಸಿದ್ಧವಾಗುತ್ತಿದೆ. ನೀವು PicShelf ಬಳಸುತ್ತಿರಬಹುದು.','ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ','ಹಂಚಿಕೆ ಪರದೆ ತೆರೆಯಿತು'],
    ml:['പങ്കിടൽ പാനൽ വികസിപ്പിക്കുക','പങ്കിടൽ പാനൽ ചെറുതാക്കുക','പങ്കിടൽ പാനൽ നീക്കുക','വീഡിയോ തയ്യാറാക്കുന്നു…','പങ്കിടാൻ തയ്യാറാണ്','പങ്കിടൽ സ്ക്രീൻ തുറക്കുക','{percent}% തയ്യാറായി','ശ്രദ്ധ ആവശ്യമാണ്','പശ്ചാത്തലത്തിൽ തയ്യാറാക്കുന്നു. നിങ്ങൾക്ക് PicShelf ഉപയോഗിക്കുന്നത് തുടരാം.','വീണ്ടും ശ്രമിക്കുക','പങ്കിടൽ സ്ക്രീൻ തുറന്നു'],
    pa:['ਸ਼ੇਅਰ ਪੈਨਲ ਖੋਲ੍ਹੋ','ਸ਼ੇਅਰ ਪੈਨਲ ਛੋਟਾ ਕਰੋ','ਸ਼ੇਅਰ ਪੈਨਲ ਹਿਲਾਓ','ਵੀਡੀਓ ਤਿਆਰ ਹੋ ਰਿਹਾ ਹੈ…','ਸਾਂਝਾ ਕਰਨ ਲਈ ਤਿਆਰ','ਸ਼ੇਅਰ ਸਕ੍ਰੀਨ ਖੋਲ੍ਹੋ','{percent}% ਤਿਆਰ','ਧਿਆਨ ਦਿਓ','ਪਿਛੋਕੜ ਵਿੱਚ ਤਿਆਰੀ ਚੱਲ ਰਹੀ ਹੈ। ਤੁਸੀਂ PicShelf ਵਰਤਣਾ ਜਾਰੀ ਰੱਖ ਸਕਦੇ ਹੋ।','ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ','ਸ਼ੇਅਰ ਸਕ੍ਰੀਨ ਖੁੱਲ੍ਹ ਗਈ']
  };
  const archiveWords={
    en:['Create one ZIP','{count} media files will be packaged into one ZIP. The receiving app may limit file size.','Estimated size: {size}','Available space: {size}','Size estimate is incomplete for {count} files.','Not enough free space for this estimate. Free up space or select fewer files.','Start ZIP','Estimating size…','{completed} of {total} files prepared','Creating ZIP…','Up to 1,000 files can be shared directly. The receiving app may have a smaller limit.','Check the estimated size before starting. Video edits may change the final size.'],
    hi:['एक ZIP बनाएँ','{count} मीडिया फ़ाइलें एक ZIP में रखी जाएँगी। प्राप्तकर्ता ऐप फ़ाइल का आकार सीमित कर सकता है।','अनुमानित आकार: {size}','खाली जगह: {size}','{count} फ़ाइलों के आकार का अनुमान अधूरा है।','इस अनुमान के लिए पर्याप्त खाली जगह नहीं है। जगह खाली करें या कम फ़ाइलें चुनें।','ZIP बनाना शुरू करें','आकार का अनुमान लग रहा है…','{total} में से {completed} फ़ाइलें तैयार','ZIP बन रही है…','अधिकतम 1,000 फ़ाइलें सीधे साझा की जा सकती हैं। प्राप्तकर्ता ऐप की सीमा कम हो सकती है।','शुरू करने से पहले अनुमानित आकार देखें। वीडियो संपादन से अंतिम आकार बदल सकता है।'],
    bn:['একটি ZIP তৈরি করুন','{count}টি মিডিয়া ফাইল একটি ZIP-এ রাখা হবে। গ্রহণকারী অ্যাপ ফাইলের আকার সীমিত করতে পারে।','আনুমানিক আকার: {size}','খালি জায়গা: {size}','{count}টি ফাইলের আকারের অনুমান অসম্পূর্ণ।','এই অনুমানের জন্য যথেষ্ট খালি জায়গা নেই। জায়গা খালি করুন বা কম ফাইল বাছুন।','ZIP তৈরি শুরু করুন','আকার অনুমান করা হচ্ছে…','{total}টির মধ্যে {completed}টি ফাইল প্রস্তুত','ZIP তৈরি হচ্ছে…','সরাসরি সর্বোচ্চ 1,000টি ফাইল শেয়ার করা যায়। গ্রহণকারী অ্যাপের সীমা কম হতে পারে।','শুরুর আগে আনুমানিক আকার দেখুন। ভিডিও সম্পাদনায় চূড়ান্ত আকার বদলাতে পারে।'],
    te:['ఒక ZIP సృష్టించండి','{count} మీడియా ఫైళ్లు ఒక ZIPలో చేర్చబడతాయి. స్వీకరించే యాప్ ఫైల్ పరిమాణాన్ని పరిమితం చేయవచ్చు.','అంచనా పరిమాణం: {size}','ఖాళీ స్థలం: {size}','{count} ఫైళ్ల పరిమాణ అంచనా అసంపూర్ణంగా ఉంది.','ఈ అంచనాకు సరిపడా ఖాళీ స్థలం లేదు. స్థలాన్ని ఖాళీ చేయండి లేదా తక్కువ ఫైళ్లు ఎంచుకోండి.','ZIP ప్రారంభించండి','పరిమాణాన్ని అంచనా వేస్తోంది…','{total}లో {completed} ఫైళ్లు సిద్ధం','ZIP సృష్టిస్తోంది…','గరిష్ఠంగా 1,000 ఫైళ్లను నేరుగా షేర్ చేయవచ్చు. స్వీకరించే యాప్ పరిమితి తక్కువగా ఉండవచ్చు.','ప్రారంభించే ముందు అంచనా పరిమాణాన్ని చూడండి. వీడియో సవరణలు తుది పరిమాణాన్ని మార్చవచ్చు.'],
    ta:['ஒரு ZIP உருவாக்கவும்','{count} ஊடகக் கோப்புகள் ஒரு ZIP-இல் சேர்க்கப்படும். பெறும் செயலி கோப்பு அளவை வரம்பிடலாம்.','மதிப்பிடப்பட்ட அளவு: {size}','காலி இடம்: {size}','{count} கோப்புகளின் அளவு மதிப்பீடு முழுமையடையவில்லை.','இந்த மதிப்பீட்டிற்குப் போதுமான காலி இடம் இல்லை. இடத்தைக் காலி செய்யவும் அல்லது குறைவான கோப்புகளைத் தேர்ந்தெடுக்கவும்.','ZIP உருவாக்கத் தொடங்கவும்','அளவை மதிப்பிடுகிறது…','{total} கோப்புகளில் {completed} தயார்','ZIP உருவாகிறது…','நேரடியாக அதிகபட்சம் 1,000 கோப்புகளைப் பகிரலாம். பெறும் செயலியின் வரம்பு குறைவாக இருக்கலாம்.','தொடங்கும் முன் மதிப்பிடப்பட்ட அளவைப் பார்க்கவும். வீடியோ திருத்தங்கள் இறுதி அளவை மாற்றலாம்.'],
    mr:['एक ZIP तयार करा','{count} मीडिया फाइल एका ZIP मध्ये ठेवल्या जातील. स्वीकारणारे ॲप फाइलच्या आकारावर मर्यादा घालू शकते.','अंदाजे आकार: {size}','मोकळी जागा: {size}','{count} फाइलच्या आकाराचा अंदाज अपूर्ण आहे.','या अंदाजासाठी पुरेशी मोकळी जागा नाही. जागा मोकळी करा किंवा कमी फाइल निवडा.','ZIP सुरू करा','आकाराचा अंदाज घेत आहे…','{total} पैकी {completed} फाइल तयार','ZIP तयार होत आहे…','जास्तीत जास्त 1,000 फाइल थेट शेअर करता येतात. स्वीकारणाऱ्या ॲपची मर्यादा कमी असू शकते.','सुरू करण्यापूर्वी अंदाजे आकार तपासा. व्हिडिओ संपादनामुळे अंतिम आकार बदलू शकतो.'],
    gu:['એક ZIP બનાવો','{count} મીડિયા ફાઇલો એક ZIPમાં મૂકવામાં આવશે. મેળવનાર ઍપ ફાઇલના કદને મર્યાદિત કરી શકે છે.','અંદાજિત કદ: {size}','ખાલી જગ્યા: {size}','{count} ફાઇલો માટે કદનો અંદાજ અધૂરો છે.','આ અંદાજ માટે પૂરતી ખાલી જગ્યા નથી. જગ્યા ખાલી કરો અથવા ઓછી ફાઇલો પસંદ કરો.','ZIP શરૂ કરો','કદનો અંદાજ લગાવે છે…','{total}માંથી {completed} ફાઇલો તૈયાર','ZIP બની રહી છે…','વધુમાં વધુ 1,000 ફાઇલો સીધી શેર કરી શકાય છે. મેળવનાર ઍપની મર્યાદા ઓછી હોઈ શકે છે.','શરૂ કરતાં પહેલાં અંદાજિત કદ તપાસો. વિડિયો સંપાદનથી અંતિમ કદ બદલાઈ શકે છે.'],
    kn:['ಒಂದು ZIP ರಚಿಸಿ','{count} ಮಾಧ್ಯಮ ಫೈಲ್‌ಗಳನ್ನು ಒಂದು ZIPನಲ್ಲಿ ಸೇರಿಸಲಾಗುತ್ತದೆ. ಸ್ವೀಕರಿಸುವ ಆ್ಯಪ್ ಫೈಲ್ ಗಾತ್ರವನ್ನು ಮಿತಿಗೊಳಿಸಬಹುದು.','ಅಂದಾಜು ಗಾತ್ರ: {size}','ಖಾಲಿ ಜಾಗ: {size}','{count} ಫೈಲ್‌ಗಳ ಗಾತ್ರದ ಅಂದಾಜು ಅಪೂರ್ಣವಾಗಿದೆ.','ಈ ಅಂದಾಜಿಗೆ ಸಾಕಷ್ಟು ಖಾಲಿ ಜಾಗವಿಲ್ಲ. ಜಾಗ ತೆರವುಗೊಳಿಸಿ ಅಥವಾ ಕಡಿಮೆ ಫೈಲ್ ಆಯ್ಕೆಮಾಡಿ.','ZIP ಪ್ರಾರಂಭಿಸಿ','ಗಾತ್ರ ಅಂದಾಜಿಸುತ್ತಿದೆ…','{total}ರಲ್ಲಿ {completed} ಫೈಲ್‌ಗಳು ಸಿದ್ಧ','ZIP ರಚಿಸಲಾಗುತ್ತಿದೆ…','ಗರಿಷ್ಠ 1,000 ಫೈಲ್‌ಗಳನ್ನು ನೇರವಾಗಿ ಹಂಚಿಕೊಳ್ಳಬಹುದು. ಸ್ವೀಕರಿಸುವ ಆ್ಯಪ್ ಮಿತಿ ಕಡಿಮೆಯಾಗಿರಬಹುದು.','ಪ್ರಾರಂಭಿಸುವ ಮೊದಲು ಅಂದಾಜು ಗಾತ್ರ ನೋಡಿ. ವೀಡಿಯೊ ಸಂಪಾದನೆಯಿಂದ ಅಂತಿಮ ಗಾತ್ರ ಬದಲಾಗಬಹುದು.'],
    ml:['ഒരു ZIP സൃഷ്ടിക്കുക','{count} മീഡിയ ഫയലുകൾ ഒരു ZIP-ൽ ഉൾപ്പെടുത്തും. സ്വീകരിക്കുന്ന ആപ്പ് ഫയലിന്റെ വലുപ്പം പരിമിതപ്പെടുത്തിയേക്കാം.','ഏകദേശ വലുപ്പം: {size}','ലഭ്യമായ സ്ഥലം: {size}','{count} ഫയലുകളുടെ വലുപ്പ കണക്ക് അപൂർണ്ണമാണ്.','ഈ കണക്കിന് ആവശ്യമായ സ്ഥലം ലഭ്യമല്ല. സ്ഥലം ഒഴിവാക്കുക അല്ലെങ്കിൽ കുറച്ച് ഫയലുകൾ തിരഞ്ഞെടുക്കുക.','ZIP ആരംഭിക്കുക','വലുപ്പം കണക്കാക്കുന്നു…','{total}ൽ {completed} ഫയലുകൾ തയ്യാർ','ZIP സൃഷ്ടിക്കുന്നു…','പരമാവധി 1,000 ഫയലുകൾ നേരിട്ട് പങ്കിടാം. സ്വീകരിക്കുന്ന ആപ്പിന്റെ പരിധി കുറവായിരിക്കാം.','ആരംഭിക്കുന്നതിന് മുമ്പ് ഏകദേശ വലുപ്പം നോക്കുക. വീഡിയോ തിരുത്തലുകൾ അന്തിമ വലുപ്പം മാറ്റാം.'],
    pa:['ਇੱਕ ZIP ਬਣਾਓ','{count} ਮੀਡੀਆ ਫਾਈਲਾਂ ਇੱਕ ZIP ਵਿੱਚ ਪਾਈਆਂ ਜਾਣਗੀਆਂ। ਪ੍ਰਾਪਤ ਕਰਨ ਵਾਲੀ ਐਪ ਫਾਈਲ ਦੇ ਆਕਾਰ ਨੂੰ ਸੀਮਿਤ ਕਰ ਸਕਦੀ ਹੈ।','ਅੰਦਾਜ਼ਨ ਆਕਾਰ: {size}','ਖਾਲੀ ਥਾਂ: {size}','{count} ਫਾਈਲਾਂ ਦੇ ਆਕਾਰ ਦਾ ਅੰਦਾਜ਼ਾ ਅਧੂਰਾ ਹੈ।','ਇਸ ਅੰਦਾਜ਼ੇ ਲਈ ਕਾਫ਼ੀ ਖਾਲੀ ਥਾਂ ਨਹੀਂ ਹੈ। ਥਾਂ ਖਾਲੀ ਕਰੋ ਜਾਂ ਘੱਟ ਫਾਈਲਾਂ ਚੁਣੋ।','ZIP ਸ਼ੁਰੂ ਕਰੋ','ਆਕਾਰ ਦਾ ਅੰਦਾਜ਼ਾ ਲਗਾ ਰਿਹਾ ਹੈ…','{total} ਵਿੱਚੋਂ {completed} ਫਾਈਲਾਂ ਤਿਆਰ','ZIP ਬਣ ਰਹੀ ਹੈ…','ਵੱਧ ਤੋਂ ਵੱਧ 1,000 ਫਾਈਲਾਂ ਸਿੱਧੀਆਂ ਸਾਂਝੀਆਂ ਹੋ ਸਕਦੀਆਂ ਹਨ। ਪ੍ਰਾਪਤ ਕਰਨ ਵਾਲੀ ਐਪ ਦੀ ਸੀਮਾ ਘੱਟ ਹੋ ਸਕਦੀ ਹੈ।','ਸ਼ੁਰੂ ਕਰਨ ਤੋਂ ਪਹਿਲਾਂ ਅੰਦਾਜ਼ਨ ਆਕਾਰ ਵੇਖੋ। ਵੀਡੀਓ ਸੰਪਾਦਨ ਨਾਲ ਅੰਤਿਮ ਆਕਾਰ ਬਦਲ ਸਕਦਾ ਹੈ।']
  };
  const progressWords={"en":["{percent}% overall","{completed} of {total} files ready","File {current} of {total}","This video: {percent}%","A share of {total} files is already in progress. Finish or cancel it before sharing another selection.","Drag the header to move this panel"],"hi":["कुल प्रगति: {percent}%","{total} में से {completed} फ़ाइलें तैयार हैं","{total} में से फ़ाइल {current}","यह वीडियो: {percent}%","{total} फ़ाइलें साझा करने की प्रक्रिया पहले से चल रही है। दूसरा चयन साझा करने से पहले इसे पूरा होने दें या रद्द करें।","इस पैनल को खिसकाने के लिए शीर्षक वाले हिस्से को खींचें"],"bn":["মোট অগ্রগতি: {percent}%","{total}টি ফাইলের মধ্যে {completed}টি প্রস্তুত","{total}টির মধ্যে ফাইল {current}","এই ভিডিও: {percent}%","ইতিমধ্যেই {total}টি ফাইল শেয়ার করার প্রক্রিয়া চলছে। অন্য নির্বাচন শেয়ার করার আগে এটি শেষ হতে দিন বা বাতিল করুন।","এই প্যানেল সরাতে শিরোনামের অংশটি টেনে সরান"],"te":["మొత్తం పురోగతి: {percent}%","{total} ఫైళ్లలో {completed} సిద్ధంగా ఉన్నాయి","{total}లో {current}వ ఫైల్","ఈ వీడియో: {percent}%","ఇప్పటికే {total} ఫైళ్లను షేర్ చేసే ప్రక్రియ కొనసాగుతోంది. మరో ఎంపికను షేర్ చేసే ముందు ఇది పూర్తయ్యే వరకు వేచి ఉండండి లేదా రద్దు చేయండి.","ఈ ప్యానెల్‌ను జరపడానికి శీర్షిక భాగాన్ని లాగండి"],"ta":["மொத்த முன்னேற்றம்: {percent}%","{total} கோப்புகளில் {completed} தயார்","{total} கோப்புகளில் {current}-வது கோப்பு","இந்த வீடியோ: {percent}%","{total} கோப்புகளைப் பகிரும் செயல்முறை ஏற்கனவே நடைபெறுகிறது. வேறு தேர்வைப் பகிரும் முன் இது முடியும் வரை காத்திருக்கவும் அல்லது ரத்து செய்யவும்.","இந்தப் பலகையை நகர்த்த தலைப்புப் பகுதியை இழுக்கவும்"],"mr":["एकूण प्रगती: {percent}%","{total} पैकी {completed} फाइल तयार आहेत","{total} पैकी फाइल {current}","हा व्हिडिओ: {percent}%","{total} फाइल शेअर करण्याची प्रक्रिया आधीच सुरू आहे. दुसरी निवड शेअर करण्यापूर्वी ही प्रक्रिया पूर्ण होऊ द्या किंवा रद्द करा.","हे पॅनेल हलवण्यासाठी शीर्षकाचा भाग ओढा"],"gu":["કુલ પ્રગતિ: {percent}%","{total}માંથી {completed} ફાઇલો તૈયાર છે","{total}માંથી ફાઇલ {current}","આ વિડિયો: {percent}%","{total} ફાઇલો શેર કરવાની પ્રક્રિયા પહેલેથી ચાલુ છે. બીજી પસંદગી શેર કરતાં પહેલાં તેને પૂર્ણ થવા દો અથવા રદ કરો.","આ પેનલને ખસેડવા માટે શીર્ષકવાળો ભાગ ખેંચો"],"kn":["ಒಟ್ಟು ಪ್ರಗತಿ: {percent}%","{total} ಫೈಲ್‌ಗಳಲ್ಲಿ {completed} ಸಿದ್ಧವಾಗಿವೆ","{total}ರಲ್ಲಿ {current}ನೇ ಫೈಲ್","ಈ ವೀಡಿಯೊ: {percent}%","ಈಗಾಗಲೇ {total} ಫೈಲ್‌ಗಳನ್ನು ಹಂಚಿಕೊಳ್ಳುವ ಪ್ರಕ್ರಿಯೆ ನಡೆಯುತ್ತಿದೆ. ಮತ್ತೊಂದು ಆಯ್ಕೆಯನ್ನು ಹಂಚಿಕೊಳ್ಳುವ ಮೊದಲು ಇದು ಮುಗಿಯಲು ಕಾಯಿರಿ ಅಥವಾ ರದ್ದುಮಾಡಿ.","ಈ ಫಲಕವನ್ನು ಸರಿಸಲು ಶೀರ್ಷಿಕೆಯ ಭಾಗವನ್ನು ಎಳೆಯಿರಿ"],"ml":["ആകെ പുരോഗതി: {percent}%","{total} ഫയലുകളിൽ {completed} എണ്ണം തയ്യാറാണ്","{total} ഫയലുകളിൽ {current}-ാം ഫയൽ","ഈ വീഡിയോ: {percent}%","{total} ഫയലുകൾ പങ്കിടുന്ന പ്രക്രിയ ഇതിനകം നടക്കുന്നു. മറ്റൊരു തിരഞ്ഞെടുപ്പ് പങ്കിടുന്നതിന് മുമ്പ് ഇത് പൂർത്തിയാകാൻ കാത്തിരിക്കുക അല്ലെങ്കിൽ റദ്ദാക്കുക.","ഈ പാനൽ നീക്കാൻ തലക്കെട്ടുള്ള ഭാഗം വലിച്ചുനീക്കുക"],"pa":["ਕੁੱਲ ਪ੍ਰਗਤੀ: {percent}%","{total} ਵਿੱਚੋਂ {completed} ਫਾਈਲਾਂ ਤਿਆਰ ਹਨ","{total} ਵਿੱਚੋਂ ਫਾਈਲ {current}","ਇਹ ਵੀਡੀਓ: {percent}%","{total} ਫਾਈਲਾਂ ਸਾਂਝੀਆਂ ਕਰਨ ਦੀ ਪ੍ਰਕਿਰਿਆ ਪਹਿਲਾਂ ਹੀ ਚੱਲ ਰਹੀ ਹੈ। ਕੋਈ ਹੋਰ ਚੋਣ ਸਾਂਝੀ ਕਰਨ ਤੋਂ ਪਹਿਲਾਂ ਇਸ ਨੂੰ ਪੂਰਾ ਹੋਣ ਦਿਓ ਜਾਂ ਰੱਦ ਕਰੋ।","ਇਸ ਪੈਨਲ ਨੂੰ ਹਿਲਾਉਣ ਲਈ ਸਿਰਲੇਖ ਵਾਲਾ ਹਿੱਸਾ ਖਿੱਚੋ"]};
  const DIRECT_LIMIT=1000,ARCHIVE_BATCH_SIZE=100,SPACE_RESERVE=64*1024*1024;
  let current=null,ui=null,sequence=0,expanded=false,position=null,drag=null,positionFrame=0,paintFrame=0,readyTimer=0;
  function tr(index,values={}) {let text=(words[window.state?.language]||words.en)[index];for(const [k,v] of Object.entries(values))text=text.replaceAll('{'+k+'}',String(v));return text;}
  function pt(index,values={}) {let text=(panelWords[window.state?.language]||panelWords.en)[index];for(const [k,v] of Object.entries(values))text=text.replaceAll('{'+k+'}',String(v));return text;}
  function at(index,values={}) {let text=(archiveWords[window.state?.language]||archiveWords.en)[index];for(const [k,v] of Object.entries(values))text=text.replaceAll('{'+k+'}',String(v));return text;}
  function gt(index,values={}) {let text=(progressWords[window.state?.language]||progressWords.en)[index];for(const [k,v] of Object.entries(values))text=text.replaceAll('{'+k+'}',String(v));return text;}
  function number(value) {try{return new Intl.NumberFormat(window.state?.language||'en',{maximumFractionDigits:1}).format(value);}catch(_){return String(value);}}
  function bytes(value) {const units=['B','KB','MB','GB','TB','PB'];let index=0;while(value>=1000&&index<units.length-1){value/=1000;index++;}return number(value)+' '+units[index];}
  function node(tag,className,parent) {const e=document.createElement(tag);e.className=className;if(parent)parent.append(e);return e;}
  function place() {
    positionFrame=0;if(!ui||ui.modal.hidden)return;
    const viewport=window.visualViewport,width=viewport?.width||window.innerWidth,height=viewport?.height||window.innerHeight,left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0;
    const gap=10,reserve=Math.min(88,Math.max(24,height*.15)),preferred=expanded?360:264,minimum=Math.min(264,Math.max(80,width-gap*2));
    const bottom=top+height-reserve-gap;
    const maxX=Math.max(left+gap,left+width-(drag?.width||minimum)-gap),maxY=Math.max(top+gap,bottom-(drag?.height||Math.min(150,height-reserve-gap*2)));
    const x=Math.min(maxX,Math.max(left+gap,position?.x??left+width-Math.min(preferred,width-gap*2)-gap));
    const y=Math.min(maxY,Math.max(top+gap,position?.y??top+gap));
    // Grow/scroll inside the space below the user's anchor. Progress, language,
    // and expansion changes must not move the panel to a different location.
    position={x,y};
    ui.modal.style.width=Math.max(80,Math.min(drag?.width||preferred,left+width-gap-x))+'px';
    ui.card.style.maxHeight=Math.max(80,bottom-y)+'px';
    ui.modal.style.left=Math.round(x)+'px';ui.modal.style.top=Math.round(y)+'px';
  }
  function schedulePlace() {if(!positionFrame)positionFrame=window.requestAnimationFrame(place);}
  function queuePaint() {if(!paintFrame)paintFrame=window.requestAnimationFrame(()=>{paintFrame=0;paint();});}
  function setExpanded(value) {expanded=!!value;paint();}
  function endDrag(event) {if(!drag||event&&event.pointerId!==drag.id)return;place();const id=drag.id;drag=null;ui.modal.classList.remove('media-share-dragging');try{if(ui.head.hasPointerCapture(id))ui.head.releasePointerCapture(id);}catch(_){};schedulePlace();}
  function resumePrepared(s,automatic=false) {
    if(current!==s||s.status!=='prepared'||document.visibilityState==='hidden'||window.state?.isAppLocked)return;
    if(automatic&&s.automaticAttempt)return;s.automaticAttempt=true;
    try{if(window.AndroidApp?.resumeMediaShare(s.requestId)===false)throw Error('missing preparation');}catch(_){clearReadyTimer();s.status='error';s.error=tr(8);paint();}
  }
  function clearReadyTimer() {if(readyTimer){clearTimeout(readyTimer);readyTimer=0;}}
  function scheduleReadyCheck(s) {
    if(readyTimer||current!==s||s.status!=='prepared'||document.visibilityState==='hidden')return;
    readyTimer=setTimeout(()=>{readyTimer=0;if(current!==s||s.status!=='prepared')return;paint();s.automaticAttempt=false;resumePrepared(s,true);scheduleReadyCheck(s);},500);
  }
  function onResume() {const s=current;if(!s)return;paint();if(s.status==='prepared'){s.automaticAttempt=false;resumePrepared(s,true);scheduleReadyCheck(s);}}
  function retry() {
    const s=current;if(!s||document.visibilityState==='hidden'||window.state?.isAppLocked)return;
    if(s.status==='ready'&&typeof window.AndroidApp?.reopenMediaShare==='function'){
      try{if(window.AndroidApp.reopenMediaShare(s.requestId)!==false)return;}
      catch(_){s.status='error';s.error=tr(8);paint();return;}
    }
    if(s.archive){s.offset=0;s.batchPhotos=null;s.archiveBegun=false;estimateArchive(s);}else prepare(s);
  }
  function createUI() {
    if(ui)return;
    const modal=node('section','');modal.id='mediaShareModal';modal.hidden=true;modal.setAttribute('aria-labelledby','mediaShareTitle');
    const card=node('div','media-share-card',modal),head=node('div','media-share-header',card),move=node('button','media-share-move',head);move.type='button';move.textContent='⠿';
    const title=node('h2','media-share-title',head);title.id='mediaShareTitle';
    const toggle=node('button','media-share-toggle',head);toggle.type='button';toggle.setAttribute('aria-controls','mediaShareDetails');toggle.onclick=()=>setExpanded(!expanded);
    const statusRow=node('div','media-share-status-row',card),status=node('p','media-share-status',statusRow),percent=node('span','media-share-percent',statusRow);status.setAttribute('role','status');
    const progress=node('progress','media-share-progress',card);progress.max=1;
    const summary=node('p','media-share-summary',card);
    const detail=node('div','media-share-details',card);detail.id='mediaShareDetails';
    const item=node('p','media-share-item-progress',detail),file=node('p','media-share-file',detail),background=node('p','media-share-background',detail),estimate=node('p','media-share-estimate',detail),available=node('p','media-share-available',detail),uncertain=node('p','media-share-uncertain',detail),info=node('p','media-share-info',detail);
    const error=node('p','media-share-error',detail);error.setAttribute('role','alert');
    const actions=node('div','media-share-actions',detail);
    const button=(name,style,fn)=>{const b=node('button','btn '+style+' media-share-'+name,actions);b.type='button';b.onclick=fn;return b;};
    const cancel=button('cancel','btn-outline',close),retryButton=button('retry','btn-outline',retry),open=button('open','btn-primary',onResume),done=button('done','btn-primary',close);
    modal.addEventListener('keydown',e=>{if(e.key==='Escape'&&expanded){e.preventDefault();e.stopPropagation();setExpanded(false);}});
    head.addEventListener('pointerdown',e=>{if(e.button!==0||!current||drag||e.target===toggle||toggle.contains(e.target))return;const box=modal.getBoundingClientRect();drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:box.left,top:box.top,width:box.width,height:Math.min(box.height,150)};head.setPointerCapture(e.pointerId);modal.classList.add('media-share-dragging');e.preventDefault();});
    head.addEventListener('pointermove',e=>{if(drag?.id!==e.pointerId)return;position={x:drag.left+e.clientX-drag.x,y:drag.top+e.clientY-drag.y};e.preventDefault();schedulePlace();});
    for(const name of ['pointerup','pointercancel','lostpointercapture'])head.addEventListener(name,endDrag);
    move.addEventListener('keydown',e=>{const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!delta)return;const box=modal.getBoundingClientRect(),step=e.shiftKey?32:16;position={x:box.left+delta[0]*step,y:box.top+delta[1]*step};e.preventDefault();schedulePlace();});
    document.body.append(modal);ui={modal,card,head,title,move,toggle,status,percent,detail,summary,item,file,background,estimate,available,uncertain,info,progress,error,cancel,retry:retryButton,open,done};
    window.addEventListener('resize',schedulePlace,{passive:true});window.visualViewport?.addEventListener('resize',schedulePlace,{passive:true});
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden')onResume();});
    if(typeof ResizeObserver==='function')new ResizeObserver(schedulePlace).observe(card);
  }
  function paint() {
    const s=current;if(!s||!ui)return;
    ui.modal.hidden=!!window.state?.isAppLocked;ui.modal.classList.toggle('media-share-expanded',expanded);ui.detail.hidden=!expanded;ui.title.textContent=tr(0);
    ui.move.setAttribute('aria-label',pt(2));ui.move.title=gt(5);ui.head.title=gt(5);ui.toggle.textContent=expanded?'−':'⌄';ui.toggle.setAttribute('aria-label',pt(expanded?1:0));ui.toggle.title=pt(expanded?1:0);ui.toggle.setAttribute('aria-expanded',String(expanded));
    const working=['preparing','snapshot','estimating'].includes(s.status),video=s.phase==='processing'||s.phase==='video'||s.phase==='processing-video',fraction=s.fraction,known=Number.isFinite(fraction),percent=known?Math.min(working?99:100,Math.max(0,Math.floor(fraction*100))):0;
    ui.status.textContent=s.status==='estimating'?at(7):working?(video?pt(3):s.phase==='archiving'?at(9):tr(1)):(s.status==='prepared'||s.status==='ready')?pt(4):pt(7);
    ui.percent.textContent=gt(0,{percent:number(percent)});ui.percent.hidden=!working||!known;ui.percent.setAttribute('aria-label',ui.percent.textContent);
    ui.summary.textContent=gt(1,{completed:number(s.completed||0),total:number(s.total)});
    ui.item.textContent=s.currentIndex?gt(2,{current:number(s.currentIndex),total:number(s.total)})+(video&&Number.isFinite(s.itemFraction)?' · '+gt(3,{percent:number(Math.min(100,Math.max(0,Math.floor(s.itemFraction*100))))}):''):'';ui.item.hidden=!working||!ui.item.textContent;
    ui.file.textContent=s.fileName||'';ui.file.hidden=!s.fileName||(!working&&(s.total>1||s.archive));
    ui.background.textContent=working?pt(8):s.status==='ready'?tr(3):'';ui.background.hidden=!ui.background.textContent;
    ui.estimate.textContent=s.archive&&Number.isFinite(s.estimatedBytes)?at(2,{size:bytes(s.estimatedBytes)}):'';ui.estimate.hidden=!ui.estimate.textContent;
    ui.available.textContent=s.archive&&Number.isFinite(s.freeBytes)?at(3,{size:bytes(s.freeBytes)}):'';ui.available.hidden=!ui.available.textContent;
    ui.uncertain.textContent=s.archive&&s.unknownSizes?at(4,{count:number(s.unknownSizes)}):'';ui.uncertain.hidden=!ui.uncertain.textContent;
    ui.info.textContent=s.archive?at(1,{count:number(s.total)}):'';ui.info.hidden=!ui.info.textContent;
    ui.progress.hidden=!working;if(known)ui.progress.value=fraction;else ui.progress.removeAttribute('value');ui.progress.setAttribute('aria-label',ui.status.textContent+(known?' '+percent+'%':''));
    ui.error.textContent=s.error||'';ui.error.hidden=!s.error;
    ui.cancel.textContent=tr(7);ui.cancel.hidden=s.status==='ready';
    ui.retry.textContent=s.status==='error'?pt(9):tr(5);ui.retry.hidden=working||s.status==='prepared';
    ui.open.textContent=pt(5);ui.open.hidden=s.status!=='prepared';
    ui.done.textContent=tr(6);ui.done.hidden=s.status!=='ready';
    schedulePlace();
  }
  function close() {
    const s=current;if(!s)return;current=null;s.cancelled=true;
    clearReadyTimer();
    if(s.requestId)try{window.AndroidApp?.cancelMediaShare(s.requestId);}catch(_){}
    if(!s.submitted)for(const token of s.tokens)try{window.AndroidApp?.discardMediaShareStream(token);}catch(_){}
    endDrag();ui.modal.hidden=true;
  }
  function check(s) {if(current!==s||s.cancelled)throw Error('cancelled');}
  function info(photo,blob) {
    const formats={...types,aif:'audio/aiff',aiff:'audio/aiff'};
    const aliases={'image/jpg':'image/jpeg','audio/x-aiff':'audio/aiff','audio/x-wav':'audio/wav','audio/wave':'audio/wav','audio/x-flac':'audio/flac','video/x-m4v':'video/mp4'};
    const mimeValue=value=>String(value||'').split(';')[0].trim().toLowerCase();
    const canonical=value=>aliases[mimeValue(value)]||mimeValue(value);
    const extension=value=>String(value||'').match(/\.([a-z0-9]{1,16})$/i)?.[1].toLowerCase()||'';
    const kind=typeof window.screenMediaKind==='function'?window.screenMediaKind(photo):photo.mediaType==='video'?'video':photo.mediaType==='audio'?'audio':'image';
    const asset=kind==='video'?photo.videoUrl:kind==='audio'?(photo.audioUrl||photo.videoUrl):photo.dataUrl;
    const assetName=/^(assets\/|web\/assets\/|file:\/\/\/android_asset\/web\/assets\/)/.test(asset||'')?asset.split('/').pop():'';
    const original=photo.tarEntry?.baseName||photo.zipEntry?.baseName||photo.zipEntry?.fn||photo.originalFilename||photo.originalFileName||photo.fileBlob?.name||assetName||'';
    const sourceExt=extension(original),storedExt=extension(photo.mediaFileExtension),titleExt=extension(photo.displayName);
    const explicitMime=[blob?.type,photo.fileBlob?.type,photo.mimeType,photo.mime].map(mimeValue).find(value=>value.startsWith(kind+'/'));
    const mime=[blob?.type,formats[sourceExt],photo.fileBlob?.type,photo.mimeType,photo.mime,formats[storedExt],formats[titleExt]]
      .map(mimeValue).find(value=>value.startsWith(kind+'/'))||(kind==='video'?'video/mp4':kind==='audio'?'audio/mpeg':'image/jpeg');
    // Only explicit source metadata may supply an unfamiliar suffix. A title
    // such as "Family trip" must never become its own file extension.
    const compatible=ext=>ext&&(formats[ext]?canonical(formats[ext])===canonical(mime):!!explicitMime);
    const ext=[sourceExt,storedExt].find(compatible)||(formats[titleExt]&&compatible(titleExt)?titleExt:'')||
      Object.keys(formats).find(key=>canonical(formats[key])===canonical(mime))||(kind==='video'?'mp4':kind==='audio'?'mp3':'jpg');
    let name=String(photo.displayName||original||'PicShelf_media').replace(/[/\\:*?"<>|\x00-\x1f]/g,'_');
    const suffix=extension(name);
    if(suffix&&(suffix===ext||formats[suffix]||suffix===sourceExt||suffix===storedExt))name=name.slice(0,-suffix.length-1);
    name=name.trim().slice(0,200)||'PicShelf_media';
    return {mime,kind,fileName:name+'.'+ext};
  }
  function videoEdit(p) {
    const edit={};
    if(p.videoCrop){const c=p.videoCrop;edit.crop={cropW:c.cropW,cropH:c.cropH,aspect:c.aspect,normBox:c.normBox?{...c.normBox}:undefined,rotation:c.rotation||0,customAngle:c.customAngle||0,flipH:!!c.flipH,flipV:!!c.flipV};}
    else if(p.videoResize){const r=p.videoResize;edit.resize={targetW:r.targetW,targetH:r.targetH,fitMode:r.fitMode||'contain',rotation:r.rotation||0,customAngle:r.customAngle||0,flipH:!!r.flipH,flipV:!!r.flipV};}
    if(p.trimStart!=null)edit.trimStart=p.trimStart;if(p.trimEnd!=null)edit.trimEnd=p.trimEnd;
    if(p.audioRemoved||p.isMuted||p.muteAudioOnExport||/^clip_noaudio_/.test(String(p.id)))edit.mute=true;
    if(p.videoLooks)edit.looks=JSON.parse(JSON.stringify(p.videoLooks));return edit;
  }
  function photoSnapshot(p) {
    return {...p,tarEntry:p.tarEntry?{...p.tarEntry}:undefined,zipEntry:p.zipEntry?{...p.zipEntry}:undefined,
      videoCrop:p.videoCrop?{...p.videoCrop,normBox:p.videoCrop.normBox?{...p.videoCrop.normBox}:undefined}:undefined,
      videoResize:p.videoResize?{...p.videoResize}:undefined,videoLooks:p.videoLooks?JSON.parse(JSON.stringify(p.videoLooks)):undefined};
  }
  function renderKey(p,edit) {
    if(typeof window.VideoDownloadHistory?.key==='function')return window.VideoDownloadHistory.key(p,edit);
    const source=window.ArchiveSources?.nativeInfo(p)||{id:p.id,size:p.fileBlob?.size||p.fileSize||0,url:/^blob:/.test(p.videoUrl||'')?null:p.videoUrl};
    return JSON.stringify({id:p.id,source,modified:p.lastEditedAt||null,edit});
  }
  function readBlob(url) {return new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET',url,true);x.responseType='blob';x.onload=()=>((x.status===0||x.status>=200&&x.status<300)&&x.response?.size>0)?resolve(x.response):reject(Error('read'));x.onerror=()=>reject(Error('read'));x.send();});}
  async function originalBlob(p,kind,legacy) {
    if(kind==='image'&&(p.lastEditedAt||p.originalDataUrl)&&p.dataUrl)return readBlob(p.dataUrl);
    if(p.fileBlob instanceof Blob)return p.fileBlob;
    if(legacy){const own=await window.getMediaBlobFromIDB?.(p.id);if(own instanceof Blob)return own;if(p.videoUrl&&!/^data:image\//.test(p.videoUrl))return readBlob(p.videoUrl);throw Error('clip');}
    if(window.ArchiveSources?.entryInfo(p))return window.ArchiveSources.originalBlob(p);
    if(p.tarEntry?.tarFile instanceof Blob){const e=p.tarEntry;return e.tarFile.slice(e.offset,e.offset+e.size);}
    if(p.zipEntry?.zipFile instanceof Blob){const e=p.zipEntry,h=new DataView(await e.zipFile.slice(e.localOffset,e.localOffset+30).arrayBuffer());if(h.getUint32(0,true)!==0x04034b50)throw Error('zip');const start=e.localOffset+30+h.getUint16(26,true)+h.getUint16(28,true),part=e.zipFile.slice(start,start+e.compSize);if(e.method===0)return part;if(e.method!==8)throw Error('zip');try{return await new Response(part.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();}catch(_){const code=window._ZIP_WORKER_SCRIPT+'\nself.onmessage=async({data})=>{try{self.postMessage({blob:new Blob([self.pako.inflateRaw(new Uint8Array(await data.arrayBuffer()))])});}catch(e){self.postMessage({error:String(e)});}}';return new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'})),w=new Worker(url);URL.revokeObjectURL(url);w.onmessage=({data})=>{w.terminate();data.error?reject(Error(data.error)):resolve(data.blob);};w.onerror=e=>{w.terminate();reject(Error(e.message));};w.postMessage(part);});}}
    const saved=await window.getMediaBlobFromIDB?.(p.id);if(saved instanceof Blob)return saved;
    let url=kind==='video'?p.videoUrl:kind==='audio'?(p.audioUrl||p.videoUrl||p.dataUrl):p.dataUrl;
    if(!url&&p.gradient)url=window.generateGradientImage(p.displayName,p.category,p.gradient);
    if(!url||(kind!=='image'&&/^data:image\//.test(url)))throw Error('missing');return readBlob(url);
  }
  async function stage(blob,s) {
    check(s);const token=window.AndroidApp.beginMediaShareStream(s.requestId,blob.size);if(!token)throw Error('stage');s.tokens.push(token);
    for(let offset=0;offset<blob.size;offset+=1048576){check(s);const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=()=>reject(r.error);r.readAsDataURL(blob.slice(offset,offset+1048576));});check(s);if(!window.AndroidApp.appendMediaShareStream(token,data))throw Error('stage');await pause();}
    if(!window.AndroidApp.sealMediaShareStream(token))throw Error('stage');return{staged:token};
  }
  async function prepareItem(original,s,native) {
    if(!original||original.deletedAt)throw Error('missing');const p=photoSnapshot(original);let meta=info(p),source=null,size=0,edit=meta.kind==='video'?videoEdit(p):null;
    const editedVideo=!!edit&&Object.keys(edit).length>0,key=editedVideo?renderKey(p,edit):null;
    const legacy=meta.kind==='video'&&/^clip_/.test(String(p.id))&&!p.sharedVideoSource;
    if(native&&meta.kind==='video'){const previous=await window.VideoDownloadHistory?.find(p,edit);check(s);if(original.deletedAt)throw Error('missing');if(previous){return{fileName:meta.fileName.replace(/\.[^.]+$/,'.'+(previous.fileName||'video.mp4').split('.').pop()),mime:previous.mime||'video/mp4',expectedSize:previous.fileSize,source:{exported:previous}};}}
    if(native&&key&&typeof window.AndroidApp?.findMediaShareCache==='function'){
      try{const text=window.AndroidApp.findMediaShareCache(key),cached=text?JSON.parse(text):null;if(cached?.source?.cached&&cached.expectedSize>0&&/^video\//.test(cached.mime)){check(s);if(original.deletedAt)throw Error('missing');return{...cached,fileName:meta.fileName.replace(/\.[^.]+$/,'.mp4')};}}catch(error){if(error.message==='missing'||error.message==='cancelled')throw error;}
    }
    const editedImage=meta.kind==='image'&&(p.lastEditedAt||p.originalDataUrl);
    if(native&&!legacy&&!editedImage){source=window.ArchiveSources?.nativeInfo(p);if(source){size=window.ArchiveSources.entryInfo(p).length;}}
    if(native&&!source&&!legacy&&!editedImage){const url=meta.kind==='image'?p.dataUrl:meta.kind==='audio'?(p.audioUrl||p.videoUrl||p.dataUrl):p.videoUrl;if(/^(assets\/|web\/assets\/|file:\/\/\/android_asset\/web\/assets\/)/.test(url||''))source={asset:url};}
    let blob;if(!source){blob=await originalBlob(p,meta.kind,legacy);check(s);if(!blob?.size)throw Error('empty');if(meta.kind!=='image'&&/^image\//.test(blob.type))throw Error('poster');meta=info(p,blob.type?blob:null);size=blob.size;if(native)source=await stage(blob,s);}
    if(!native){if(edit&&Object.keys(edit).length)throw Error('edited-browser-video');return new File([blob],meta.fileName,{type:meta.mime});}
    if(original.deletedAt)throw Error('missing');
    return{fileName:meta.fileName,mime:meta.mime,expectedSize:size||0,source,...(editedVideo?{videoEdit:edit,renderKey:key}:{})};
  }
  async function prepare(s,continuation=false) {
    if(!s||current!==s||s.status==='preparing'&&!continuation)return;
    clearReadyTimer();
    if(!s.archive){s.requestId='share-'+Date.now()+'-'+(++sequence);s.completed=0;s.currentIndex=0;}
    s.status='preparing';s.end=Math.min(s.total,s.offset+(s.archive?ARCHIVE_BATCH_SIZE:DIRECT_LIMIT));s.error='';s.fraction=s.archive?Math.max(s.fraction||0,s.offset/s.total):null;s.itemFraction=null;s.phase='';s.tokens=[];s.submitted=false;s.automaticAttempt=false;paint();
    const native=typeof window.AndroidApp?.shareMediaBatch==='function';
    try{
      const batch=[];
      if(!s.batchPhotos)s.batchPhotos=s.photos.slice(s.offset,s.end);
      for(let i=0;i<s.batchPhotos.length;i++){check(s);s.currentIndex=s.offset+i+1;s.fileName=s.batchPhotos[i]?.displayName||'';queuePaint();batch.push(await prepareItem(s.batchPhotos[i],s,native));if(i%8===7)await pause();}
      check(s);
      if(native){s.submitted=true;if(s.archive){s.archiveAwaiting=true;window.AndroidApp.shareMediaArchiveBatch(JSON.stringify({requestId:s.requestId,items:batch}));}else window.AndroidApp.shareMediaBatch(JSON.stringify({requestId:s.requestId,items:batch}));}
      else{if(!navigator.share||!navigator.canShare?.({files:batch}))throw Error('unsupported');await navigator.share({files:batch});check(s);s.status='ready';s.completed=s.total;s.fraction=1;paint();}
    }catch(error){if(current!==s||s.cancelled)return;try{window.AndroidApp?.cancelMediaShare(s.requestId);}catch(_){};for(const token of s.tokens)try{window.AndroidApp?.discardMediaShareStream(token);}catch(_){};s.status='error';s.error=error.name==='AbortError'?'':error.message==='unsupported'?tr(10):tr(8);paint();}
  }
  async function estimateArchive(s) {
    if(current!==s)return;s.status='estimating';s.fraction=null;s.error='';s.completed=0;s.currentIndex=0;s.fileName='';s.itemFraction=null;s.phase='';paint();
    try{
      let estimated=0,unknown=0,lastYield=performance.now();
      for(const p of s.photos){check(s);if(p.deletedAt)throw Error('missing');const entry=window.ArchiveSources?.entryInfo(p),size=entry?.length||p.fileBlob?.size||p.fileSize||p.tarEntry?.size||p.zipEntry?.uncompSize;
        if(Number.isFinite(size)&&size>0)estimated+=size;else unknown++;
        estimated+=128+String(p.displayName||'').length*6;
        if(performance.now()-lastYield>6){await pause();lastYield=performance.now();}
      }
      check(s);s.estimatedBytes=estimated;s.unknownSizes=unknown;
      const free=typeof window.AndroidApp?.getMediaShareFreeBytes==='function'?Number(window.AndroidApp.getMediaShareFreeBytes()):NaN;s.freeBytes=Number.isFinite(free)&&free>=0?free:null;
      if(s.freeBytes!==null&&estimated>Math.max(0,s.freeBytes-SPACE_RESERVE)){s.status='error';s.error=at(5);paint();return;}
      if(typeof window.AndroidApp?.beginMediaShareArchive!=='function')throw Error('unsupported');
      s.requestId='share-'+Date.now()+'-'+(++sequence);s.offset=0;s.batchPhotos=null;
      if(!window.AndroidApp.beginMediaShareArchive(s.requestId,s.total))throw Error('archive');
      s.archiveBegun=true;await prepare(s);
    }catch(error){if(current!==s||s.cancelled)return;s.status='error';s.error=error.message==='unsupported'?tr(10):tr(8);paint();}
  }
  async function snapshotSelection(s,photos,selection) {
    try{
      // Capture membership and ordering before yielding, retaining only references.
      const source=Array.from(photos),selected=selection?new Set(selection):null;
      await pause();check(s);
      if(selected){const items=[];let lastYield=performance.now();for(const p of source){if(selected.has(p.id))items.push(p);if(performance.now()-lastYield>6){await pause();check(s);lastYield=performance.now();}}if(items.length!==s.total)throw Error('selection changed');s.photos=items;}
      else s.photos=source;
      check(s);if(s.archive)await estimateArchive(s);else await prepare(s);
    }catch(error){if(current!==s||s.cancelled)return;s.status='error';s.error=tr(8);paint();}
  }
  function share(photos,selection=null) {
    const total=selection?selection.size:photos?.length;
    if(!total){window.showToast?.(tr(9));return;}
    if(current){if(current.status==='ready'||current.status==='error')close();else{setExpanded(true);window.showToast?.(gt(4,{total:number(current.total)}));return;}}
    createUI();expanded=false;current={photos:[],total,offset:0,end:Math.min(total,DIRECT_LIMIT),tokens:[],status:'snapshot',cancelled:false,archive:total>DIRECT_LIMIT,fraction:null,completed:0,currentIndex:0};paint();snapshotSelection(current,photos,selection);
  }
  function onNative(message) {
    const s=current;if(!s||message.requestId!==s.requestId||s.cancelled)return;
    if(message.status==='preparing'){
      if(Number.isFinite(message.fraction))s.fraction=Math.max(s.fraction||0,Math.min(.9999,Math.max(0,message.fraction)));
      s.itemFraction=Number.isFinite(message.itemFraction)?message.itemFraction:null;s.phase=message.phase||'';
      if(message.fileName)s.fileName=message.fileName;
      if(Number.isFinite(message.completed)){s.completed=Math.max(s.completed||0,Math.min(s.total,Math.max(0,Math.floor(message.completed))));s.currentIndex=Math.min(s.total,Math.max(1,s.completed+(s.phase==='processing'||s.phase==='archiving'?1:0)));}
      queuePaint();return;
    }
    if(message.status==='archiveBatchReady'){
      if(!s.archive||!s.archiveAwaiting)return;s.archiveAwaiting=false;
      if(message.completed!==s.end){s.status='error';s.error=tr(8);try{window.AndroidApp?.cancelMediaShare(s.requestId);}catch(_){};paint();return;}
      s.completed=message.completed;s.offset=message.completed;s.batchPhotos=null;s.bytesWritten=message.bytesWritten;
      if(s.offset<s.total)prepare(s,true);return;
    }
    clearReadyTimer();
    s.status=['ready','prepared'].includes(message.status)?message.status:'error';s.error=s.status==='error'?(message.status==='cancelled'?tr(13):tr(8)):'';
    if(s.status==='ready'||s.status==='prepared'){s.fraction=1;s.completed=s.total;s.fileName=message.fileName||s.fileName;}
    paint();if(s.status==='prepared'){resumePrepared(s,true);scheduleReadyCheck(s);}
  }
  window.MediaShare={share,shareSelected:share,onNative,close,onResume,isOpen:()=>!!current,handleBack:()=>{if(current&&expanded){setExpanded(false);return true;}return false;}};
})();
