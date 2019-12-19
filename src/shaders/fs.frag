precision highp float;
uniform sampler2D u_sampler2D_ImageToDisplay;
uniform float u_float_InverseFrameNumber;
in vec2 uv;
layout(location=0) out vec4 outColor;
void main() {
	vec3 linearColor = texture(u_sampler2D_ImageToDisplay, uv).xyz * u_float_InverseFrameNumber;
	vec3 color = pow(linearColor, vec3(1.0/2.2))*1.0;
	outColor = vec4(color, 1.0);
}
