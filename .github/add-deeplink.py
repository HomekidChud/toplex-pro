"""Patch the generated Capacitor Android manifest:
 - toplex:// deep link (returns the user to the app after browser sign-in)
 - <queries> so the app can tell whether ChatGPT / Claude are installed
"""
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
s = s[:i] + intent + s[i:]
queries = '''
    <queries>
        <package android:name="com.openai.chatgpt" />
        <package android:name="com.anthropic.claude" />
    </queries>
'''
j = s.index('<application')
s = s[:j] + queries.lstrip('\n') + '    ' + s[j:]
# Allow plain-http connections to a local model server on the user's own network (Ollama, LM Studio)
if 'usesCleartextTraffic' not in s:
    s = s.replace('<application', '<application android:usesCleartextTraffic="true"', 1)
open(p, 'w').write(s)

# The GPU engine opens the phone's OpenCL driver. Apps targeting Android 12+ must declare the
# vendor libraries they use, or the GPU start fails (or aborts the app). Not required, so phones
# without them still install.
s = open(p).read()
if 'libOpenCL.so' not in s:
    libs = """
        <uses-native-library android:name="libOpenCL.so" android:required="false" />
        <uses-native-library android:name="libOpenCL-car.so" android:required="false" />
        <uses-native-library android:name="libOpenCL-pixel.so" android:required="false" />
        <uses-native-library android:name="libvndksupport.so" android:required="false" />
    """
    k = s.rindex('</application>')
    s = s[:k] + libs + s[k:]
if 'largeHeap' not in s:
    s = s.replace('<application', '<application android:largeHeap="true"', 1)
open(p, 'w').write(s)
