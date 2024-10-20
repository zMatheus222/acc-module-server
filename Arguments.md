### Test command
```
node main.js '{"carGroup":"GT3","eventId":"0-acc-o1wfrt6vl1-2024-10-19-13-12","password":"rpm22","serverName":"RPM Esports - Training","start_date":"2024-10-19 13:12","temporada":"0"}' '{"ambientTemp":18,"cloudLevel":0.1,"configVersion":1,"isFixedConditionQualification":0,"postQualySeconds":15,"postRaceSeconds":15,"preRaceWaitingTimeSeconds":30,"rain":0,"sessionOverTimeSeconds":120,"sessions":[{"dayOfWeekend":2,"hourOfDay":10,"sessionDurationMinutes":1,"sessionType":"P","timeMultiplier":1},{"dayOfWeekend":2,"hourOfDay":13,"sessionDurationMinutes":1,"sessionType":"Q","timeMultiplier":1},{"dayOfWeekend":3,"hourOfDay":14,"sessionDurationMinutes":1,"sessionType":"R","timeMultiplier":1}],"simracerWeatherConditions":0,"track":"barcelona","weatherRandomness":1}'
```

## Argumento 1 infomações básicas

```
Normal (para exibição):

{
    "carGroup": "GT3",
    "eventId": "0-acc-o1wfrt6vl1-2024-10-19-13-12",
    "password": "rpm22",
    "serverName": "RPM Esports - Training",
    "start_date": "2024-10-19 13:12",
    "temporada": "0"
}

Minificado (como deve ser passado o argumento):

'{"carGroup":"GT3","eventId":"0-acc-o1wfrt6vl1-2024-10-19-13-12","password":"rpm22","serverName":"RPM Esports - Training","start_date":"2024-10-19 13:12","temporada":"0"}'

```

## Argumento 2 informações de sessão

```
Normal (para exibição):

{
    "ambientTemp": 18,
    "cloudLevel": 0.1,
    "configVersion": 1,
    "isFixedConditionQualification": 0,
    "postQualySeconds": 15,
    "postRaceSeconds": 15,
    "preRaceWaitingTimeSeconds": 30,
    "rain": 0.0,
    "sessionOverTimeSeconds": 120,
    "sessions": [
        {
          "dayOfWeekend": 2,
          "hourOfDay": 10,
          "sessionDurationMinutes": 1,
          "sessionType": "P",
          "timeMultiplier": 1
        },
        {
          "dayOfWeekend": 2,
          "hourOfDay": 13,
          "sessionDurationMinutes": 1,
          "sessionType": "Q",
          "timeMultiplier": 1
        },
        {
          "dayOfWeekend": 3,
          "hourOfDay": 14,
          "sessionDurationMinutes": 1,
          "sessionType": "R",
          "timeMultiplier": 1
        }
    ],
    "simracerWeatherConditions": 0,
    "track": "barcelona",
    "weatherRandomness": 1
}

Minificado (como deve ser passado o argumento):

'{"ambientTemp":18,"cloudLevel":0.1,"configVersion":1,"isFixedConditionQualification":0,"postQualySeconds":15,"postRaceSeconds":15,"preRaceWaitingTimeSeconds":30,"rain":0,"sessionOverTimeSeconds":120,"sessions":[{"dayOfWeekend":2,"hourOfDay":10,"sessionDurationMinutes":1,"sessionType":"P","timeMultiplier":1},{"dayOfWeekend":2,"hourOfDay":13,"sessionDurationMinutes":1,"sessionType":"Q","timeMultiplier":1},{"dayOfWeekend":3,"hourOfDay":14,"sessionDurationMinutes":1,"sessionType":"R","timeMultiplier":1}],"simracerWeatherConditions":0,"track":"barcelona","weatherRandomness":1}'
```