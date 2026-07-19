# www.dazn.com

https://www.dazn.com/de-DE/epg-fixture/

The German live-TV schedule is returned as one rolling response containing the current programme and approximately two further days. The config caches that response and filters it by channel and requested UTC date.

### Download the guide

```sh
npm run grab --- --sites=www.dazn.com
```

### Update channel list

```sh
npm run channels:parse --- --config=./sites/www.dazn.com/www.dazn.com.config.js --output=./sites/www.dazn.com/www.dazn.com.channels.xml
```

### Test

```sh
npm test --- www.dazn.com
```
