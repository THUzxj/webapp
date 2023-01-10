// CallPanel displays call in progress: local and remote viewports and controls.
import React from 'react';
import { FormattedMessage, defineMessages, injectIntl } from 'react-intl';

import LetterTile from './letter-tile.jsx';

import { MAX_PEER_TITLE_LENGTH } from '../config.js';
import { CALL_STATE_OUTGOING_INITATED, CALL_STATE_IN_PROGRESS } from '../constants.js';

import { clipStr } from '../lib/utils.js'

const RING_SOUND = new Audio('audio/call-out.m4a');
RING_SOUND.loop = true;
const CALL_ENDED_SOUND = new Audio('audio/call-end.m4a');
CALL_ENDED_SOUND.loop = true;
const DIALING_SOUND = new Audio('audio/dialing.m4a');

const messages = defineMessages({
  already_in_call: {
    id: 'already_in_call',
    defaultMessage: 'You already in an ongoing call!',
    description: 'Error message when the user tried to accept a new call without finishing pervious one',
  }
});

class CallPanel extends React.PureComponent {
  constructor(props) {
    super(props);

    this.state = {
      localStream: undefined,
      pc: undefined,

      previousOnInfo: undefined,
      waitingForPeer: false,
      // If true, the client has received a remote SDP from the peer and has sent a local SDP to the peer.
      callInitialSetupComplete: false,
      audioOnly: props.callAudioOnly,
      // Video mute/unmute in progress.
      videoToggleInProgress: false,
    };

    this.localStreamConstraints = {
      audio: true,
      video: !props.callAudioOnly
    };
    this.isOutgoingCall = props.callState == CALL_STATE_OUTGOING_INITATED;

    this.localRef = React.createRef();
    this.remoteRef = React.createRef();
    // Cache for remote ice candidates until initial setup gets completed.
    this.remoteIceCandidatesCache = [];

    this.onInfo = this.onInfo.bind(this);
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);

    this.createPeerConnection = this.createPeerConnection.bind(this);
    this.canSendOffer = this.canSendOffer.bind(this);
    this.drainRemoteIceCandidatesCache = this.drainRemoteIceCandidatesCache.bind(this);

    this.handleNegotiationNeededEvent = this.handleNegotiationNeededEvent.bind(this);
    this.handleICECandidateEvent = this.handleICECandidateEvent.bind(this);
    this.handleNewICECandidateMsg = this.handleNewICECandidateMsg.bind(this);
    this.handleICEConnectionStateChangeEvent = this.handleICEConnectionStateChangeEvent.bind(this);
    this.handleSignalingStateChangeEvent = this.handleSignalingStateChangeEvent.bind(this);
    this.handleICEGatheringStateChangeEvent = this.handleICEGatheringStateChangeEvent.bind(this);
    this.handleIceCandidateErrorEvent = this.handleIceCandidateErrorEvent.bind(this);
    this.handleTrackEvent = this.handleTrackEvent.bind(this);

    this.handleVideoOfferMsg = this.handleVideoOfferMsg.bind(this);
    this.handleVideoAnswerMsg = this.handleVideoAnswerMsg.bind(this);
    this.handleNewICECandidateMsg = this.handleNewICECandidateMsg.bind(this);

    this.reportError = this.reportError.bind(this);
    this.handleGetUserMediaError = this.handleGetUserMediaError.bind(this);

    this.stopTracks = this.stopTracks.bind(this);

    this.handleCloseClick = this.handleCloseClick.bind(this);
    this.handleToggleCameraClick = this.handleToggleCameraClick.bind(this);
    this.handleToggleMicClick = this.handleToggleMicClick.bind(this);

    this.handleRemoteHangup = this.handleRemoteHangup.bind(this);
    this.handleVideoCallAccepted = this.handleVideoCallAccepted.bind(this);

    this.muteVideo = this.muteVideo.bind(this);
    this.unmuteVideo = this.unmuteVideo.bind(this);
    this.emptyVideoTrack = this.emptyVideoTrack.bind(this);
  }

  componentDidMount() {
    const topic = this.props.tinode.getTopic(this.props.topic);
    this.previousOnInfo = topic.onInfo;
    topic.onInfo = this.onInfo;
    if ((this.props.callState == CALL_STATE_OUTGOING_INITATED ||
         this.props.callState == CALL_STATE_IN_PROGRESS) && this.localRef.current) {
      this.start();
    }
  }

  componentWillUnmount() {
    const topic = this.props.tinode.getTopic(this.props.topic);
    topic.onInfo = this.previousOnInfo;
    this.stop();
  }

  handleVideoCallAccepted(info) {
    RING_SOUND.pause();
    const pc = this.createPeerConnection();
    const stream = this.state.localStream;
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);

      if (track.kind == 'video' && !this.localStreamConstraints.video) {
        // This is an audio-only call.
        // Remove dummy video track (placeholder remains).
        track.stop();
        stream.removeTrack(track);
      }
    });
  }

  onInfo(info) {
    if (info.what != 'call') {
      return;
    }
    switch (info.event) {
      case 'accept':
        this.handleVideoCallAccepted(info);
        break;
      case 'answer':
        this.handleVideoAnswerMsg(info);
        break;
      case 'ice-candidate':
        this.handleNewICECandidateMsg(info);
        break;
      case 'hang-up':
        this.handleRemoteHangup(info);
        break;
      case 'offer':
        this.handleVideoOfferMsg(info);
        break;
      case 'ringing':
        // play() throws if the user did not click the app first: https://goo.gl/xX8pDD.
        RING_SOUND.play().catch(_ => {});
        break;
      default:
        console.warn("Unknown call event", info.event);
        break;
    }
  }

  // Creates an empty video track placeholder.
  emptyVideoTrack() {
    const width = 640;
    const height = 480;
    const canvas = Object.assign(document.createElement("canvas"), {width, height});
    canvas.getContext('2d').fillRect(0, 0, width, height);
    const stream = canvas.captureStream(0);
    return Object.assign(stream.getVideoTracks()[0], {enabled: false});
  }

  start() {
    if (this.state.localStream) {
      this.props.onError(this.props.intl.formatMessage(messages.already_in_call), 'info');
      return;
    }

    if (this.props.callState == CALL_STATE_IN_PROGRESS) {
      // We apparently just accepted the call.
      this.props.onInvite(this.props.topic, this.props.seq, CALL_STATE_IN_PROGRESS, this.props.callAudioOnly);
      return;
    }

    // This is an outgoing call waiting for the other side to pick up.
    // Start local video.
    navigator.mediaDevices.getUserMedia(this.localStreamConstraints)
      .then(stream => {
        if (!this.localStreamConstraints.video) {
          // Starting an audio-only call. Create a dummy video track
          // (so video can be enabled during the call if the user desires).
          stream.addTrack(this.emptyVideoTrack());
        }
        this.setState({localStream: stream, waitingForPeer: true});
        this.localRef.current.srcObject = stream;

        DIALING_SOUND.play();

        // Send call invitation.
        this.props.onInvite(this.props.topic, this.props.seq, this.props.callState, this.props.callAudioOnly);
      })
      .catch(this.handleGetUserMediaError);
  }

  stop() {
    CALL_ENDED_SOUND.pause();
    CALL_ENDED_SOUND.currentTime = 0;
    RING_SOUND.pause();
    RING_SOUND.currentTime = 0;

    this.stopTracks(this.localRef.current);
    this.stopTracks(this.remoteRef.current);
    if (this.state.pc) {
      this.state.pc.ontrack = null;
      this.state.pc.onremovetrack = null;
      this.state.pc.onremovestream = null;
      this.state.pc.onicecandidate = null;
      this.state.pc.oniceconnectionstatechange = null;
      this.state.pc.onsignalingstatechange = null;
      this.state.pc.onicegatheringstatechange = null;
      this.state.pc.onnegotiationneeded = null;
      this.state.pc.onicecandidateerror = null;

      this.state.pc.close();
    }
    this.setState({pc: null, waitingForPeer: false});
  }

  stopTracks(el) {
    if (!el) {
      return;
    }
    let stream = el.srcObject;
    if (!stream) {
      return;
    }

    let tracks = stream.getTracks();
    if (tracks) {
      tracks.forEach(track => {
        track.stop();
        track.enabled = false;
      });
    }
    el.srcObject = null;
    el.src = '';
  }

  createPeerConnection() {
    const iceServers = this.props.tinode.getServerParam('iceServers', null);
    const pc = iceServers ? new RTCPeerConnection({iceServers: iceServers}) : new RTCPeerConnection();

    pc.onicecandidate = this.handleICECandidateEvent;
    pc.oniceconnectionstatechange = this.handleICEConnectionStateChangeEvent;
    pc.onicegatheringstatechange = this.handleICEGatheringStateChangeEvent;
    pc.onsignalingstatechange = this.handleSignalingStateChangeEvent;
    pc.onnegotiationneeded = this.handleNegotiationNeededEvent;
    pc.onicecandidateerror = this.handleIceCandidateErrorEvent;
    pc.ontrack = this.handleTrackEvent;

    this.setState({pc: pc, waitingForPeer: false});
    return pc;
  }

  handleVideoAnswerMsg(info) {
    // Configure the remote description, which is the SDP payload
    // in 'info' message.
    const desc = new RTCSessionDescription(info.payload);
    this.state.pc.setRemoteDescription(desc)
      .then(_ => {
        this.setState({ callInitialSetupComplete: true }, _ => this.drainRemoteIceCandidatesCache());
      })
      .catch(this.reportError);
  }

  reportError(err) {
    this.props.onError(err.message, 'err');
  }

  canSendOffer() {
    return this.isOutgoingCall || this.state.callInitialSetupComplete;
  }

  handleNegotiationNeededEvent() {
    if (!this.canSendOffer()) {
      return;
    }
    this.state.pc.createOffer().then(offer => {
      return this.state.pc.setLocalDescription(offer);
    })
    .then(_ => {
      this.props.onSendOffer(this.props.topic, this.props.seq, this.state.pc.localDescription.toJSON());
    })
    .catch(this.reportError);
  }

  handleIceCandidateErrorEvent(event) {
    console.warn("ICE candidate error:", event);
  }

  handleICECandidateEvent(event) {
    if (event.candidate) {
      this.props.onIceCandidate(this.props.topic, this.props.seq, event.candidate.toJSON());
    }
  }

  handleNewICECandidateMsg(info) {
    const candidate = new RTCIceCandidate(info.payload);
    if (this.state.callInitialSetupComplete) {
      this.state.pc.addIceCandidate(candidate)
        .catch(this.reportError);
    } else {
      this.remoteIceCandidatesCache.push(candidate);
    }
  }

  drainRemoteIceCandidatesCache() {
    this.remoteIceCandidatesCache.forEach(candidate => {
      this.state.pc.addIceCandidate(candidate)
        .catch(this.reportError);
    });
    this.remoteIceCandidatesCache = [];
  }

  handleICEConnectionStateChangeEvent(event) {
    switch (this.state.pc.iceConnectionState) {
      case 'closed':
      case 'failed':
        this.handleCloseClick();
        break;
    }
  }

  handleSignalingStateChangeEvent(event) {
    if (this.state.pc.signalingState == 'closed') {
      this.handleCloseClick();
    }
  }

  handleICEGatheringStateChangeEvent(event) {
    // ICE gathering change state
  }

  handleTrackEvent(event) {
    // Remote video becomes available.
    this.remoteRef.current.srcObject = event.streams[0];

    if (event.track.kind == 'video') {
      // Redraw the screen when remote video stream state changes.
      event.track.onended = _ => { this.forceUpdate(); };
      event.track.onmute = _ => { this.forceUpdate(); };
      event.track.onunmute = _ => { this.forceUpdate(); };
    }
    // Make sure we display the title (peer's name) over the remote video.
    this.forceUpdate();
  }

  handleGetUserMediaError(e) {
    switch(e.name) {
      case 'NotFoundError':
        // Cannot start the call b/c no camera and/or microphone found.
        this.reportError(e.message);
        break;
      case 'SecurityError':
      case 'PermissionDeniedError':
        // Do nothing; this is the same as the user canceling the call.
        break;
      default:
        this.reportError(e.message);
        console.error("Error opening your camera and/or microphone:", e.message);
        break;
    }

    // Make sure we shut down our end of the RTCPeerConnection so we're
    // ready to try again.
    this.handleCloseClick();
  }

  handleVideoOfferMsg(info) {
    let localStream = null;
    const pc = this.state.pc ? this.state.pc : this.createPeerConnection();
    const desc = new RTCSessionDescription(info.payload);

    pc.setRemoteDescription(desc).then(_ => {
      return navigator.mediaDevices.getUserMedia(this.localStreamConstraints);
    })
    .then(stream => {
      let dummyVideo;
      if (!this.localStreamConstraints.video) {
        // Starting an audio-only call. Create an empty video track so
        // so the user can enable the video during the call.
        dummyVideo = this.emptyVideoTrack();
        stream.addTrack(dummyVideo);
      }
      localStream = stream;
      this.localRef.current.srcObject = stream;
      this.setState({localStream: stream});

      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });

      if (dummyVideo) {
        dummyVideo.stop();
        stream.removeTrack(dummyVideo);
      }
    })
    .then(_ => {
      return pc.createAnswer();
    })
    .then(answer => {
      return pc.setLocalDescription(answer);
    })
    .then(_ => {
      this.props.onSendAnswer(this.props.topic, this.props.seq, pc.localDescription.toJSON());
      this.setState({ callInitialSetupComplete: true }, _ => this.drainRemoteIceCandidatesCache());
    })
    .catch(this.handleGetUserMediaError);
  }

  // Call disconnected by remote.
  handleRemoteHangup() {
    if (!this.state.waitingForPeer) {
      // This is live call, just hang up.
      this.handleCloseClick();
    } else {
      // This is a call which is not yet connected.
      // Stop pulse animation.
      this.setState({waitingForPeer: false});
      // Change sound and wait a bit before ending it.
      RING_SOUND.pause();
      RING_SOUND.currentTime = 0;
      CALL_ENDED_SOUND.loop = true;
      CALL_ENDED_SOUND.play().catch(_ => {});
      setTimeout(_ => {
        this.handleCloseClick();
      }, 2000);
    }
  }

  handleCloseClick() {
    this.stop();
    this.props.onHangup(this.props.topic, this.props.seq);
  }

  // Ends video track and turns off the camera.
  muteVideo() {
    const stream = this.state.localStream;
    const t = stream.getVideoTracks()[0];
    t.enabled = false;
    t.stop();

    stream.removeTrack(t);
    this.setState({videoToggleInProgress: false});
  }

  unmuteVideo() {
    const pc = this.state.pc;
    navigator.mediaDevices.getUserMedia({ video: true })
      .then(stream => {
        // Will extract video track from stream and throw stream away,
        // and replace video track in the media sender.
        this.localRef.current.srcObject = null;
        const sender = pc.getSenders().find(s => s.track.kind == 'video');
        const track = stream.getVideoTracks()[0];
        // Remote track from new stream.
        stream.removeTrack(track);
        // Add this track to the existing local stream.
        this.state.localStream.addTrack(track);
        return sender.replaceTrack(track);
      })
      .then(_ => {
        this.localRef.current.srcObject = this.state.localStream;
      })
      .catch(this.handleGetUserMediaError)
      .finally(_ => { this.setState({videoToggleInProgress: false}); }); // Make sure we redraw the mute/unmute icons (e.g. camera -> camera_off).
  }

  handleToggleCameraClick() {
    if (this.state.videoToggleInProgress) {
      // Toggle currently in progress.
      return;
    }
    const tracks = this.state.localStream.getVideoTracks();
    this.setState({videoToggleInProgress: true});
    if (tracks && tracks.length > 0 && tracks[0].enabled && tracks[0].readyState == 'live') {
      this.muteVideo();
    } else {
      this.unmuteVideo();
    }
    this.setState({audioOnly: !this.state.audioOnly});
  }

  handleToggleMicClick() {
    const stream = this.state.localStream;
    const t = stream.getAudioTracks()[0];
    t.enabled = !t.enabled;
    // Make sure we redraw the mute/unmute icons (e.g. mic -> mic_off).
    this.forceUpdate();
  }

  render() {
    const audioTracks = this.state.localStream && this.state.localStream.getAudioTracks();
    const videoTracks = !this.state.audioOnly && this.state.localStream && this.state.localStream.getVideoTracks();
    const disabled = !(audioTracks && audioTracks[0]);
    const audioIcon = audioTracks && audioTracks[0] && audioTracks[0].enabled ? 'mic' : 'mic_off';
    const videoIcon = videoTracks && videoTracks[0] && videoTracks[0].enabled && videoTracks[0].readyState == 'live' ? 'videocam' : 'videocam_off';
    const peerTitle = clipStr(this.props.title, MAX_PEER_TITLE_LENGTH);
    const pulseAnimation = this.state.waitingForPeer ? ' pulse' : '';

    let remoteLive = false;
    if (this.remoteRef.current && this.remoteRef.current.srcObject) {
      const rstream = this.remoteRef.current.srcObject;
      if (rstream.getVideoTracks().length > 0) {
        const t = rstream.getVideoTracks()[0];
        remoteLive = t.enabled && t.readyState == 'live' && !t.muted;
      }
    }

    return (
      <>
        <div id="video-container">
          <div id="video-container-panel">
            <div className="call-party self" disabled={this.state.audioOnly}>
              <video ref={this.localRef} autoPlay muted playsInline />
              <div className="caller-name inactive">
                <FormattedMessage id="calls_you_label"
                  defaultMessage="You" description="Shown over the local video screen" />
              </div>
            </div>
            <div className="call-party peer" disabled={!remoteLive}>
              <video ref={this.remoteRef} autoPlay playsInline />
              {remoteLive ?
                <div className="caller-name inactive">{peerTitle}</div> :
                <div className={`caller-card${pulseAnimation}`}>
                  <div className="avatar-box">
                    <LetterTile
                      tinode={this.props.tinode}
                      avatar={this.props.avatar}
                      topic={this.props.topic}
                      title={this.props.title} />
                  </div>
                  <div className="caller-name">{peerTitle}</div>
                </div>
              }
            </div>
          </div>
          <div className="controls">
            <button className="danger" onClick={this.handleCloseClick}>
              <i className="material-icons">call_end</i>
            </button>
            <button className="secondary" onClick={this.handleToggleCameraClick} disabled={disabled}>
              <i className="material-icons">{videoIcon}</i>
            </button>
            <button className="secondary" onClick={this.handleToggleMicClick} disabled={disabled}>
              <i className="material-icons">{audioIcon}</i>
            </button>
          </div>
        </div>
      </>
    );
  }
};

export default injectIntl(CallPanel);
