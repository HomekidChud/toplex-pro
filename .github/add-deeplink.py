"""Add a toplex:// deep-link intent filter to the Capacitor Android manifest."""
import sys
p = sys.argv[1]
s = open(p).read()
intent = '''
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="toplex" />
            </intent-filter>
        '''
i = s.index('</activity>')
open(p, 'w').write(s[:i] + intent + s[i:])
